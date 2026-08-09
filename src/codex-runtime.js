import { accessSync, constants, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const MAX_ANCESTORS = 8;

function inspectUnixProcess(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=,comm="], {
    encoding: "utf8",
    timeout: 1_000
  });
  if (result.error || result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
  return match ? { parentPid: Number(match[1]), executable: match[2].trim() } : undefined;
}

function inspectLinuxProcess(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    return { parentPid: Number(fields[1]), executable: readlinkSync(`/proc/${pid}/exe`) };
  } catch {
    return undefined;
  }
}

function inspectWindowsProcess(pid) {
  const script = [
    `$p = Get-CimInstance Win32_Process -Filter \"ProcessId = ${pid}\"`,
    "if ($p) { [Console]::WriteLine(\"$($p.ParentProcessId)`t$($p.ExecutablePath)\") }"
  ].join("; ");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    timeout: 2_000,
    windowsHide: true
  });
  if (result.error || result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/^(\d+)\t(.+)$/);
  return match ? { parentPid: Number(match[1]), executable: match[2].trim() } : undefined;
}

function inspectProcess(pid, platform) {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") return inspectLinuxProcess(pid);
  if (platform === "win32") return inspectWindowsProcess(pid);
  return inspectUnixProcess(pid);
}

function isCodexExecutable(value) {
  return ["codex", "codex.exe"].includes(path.basename(value || "").toLowerCase());
}

function isDesktopCodexExecutable(value) {
  const normalized = String(value || "").replaceAll("\\", "/").toLowerCase();
  return normalized.includes(".app/contents/resources/codex")
    || normalized.includes("/chatgpt/")
    || normalized.includes("/chatgpt.app/");
}

function findExecutableOnPath(command, env, platform) {
  const pathValue = env.PATH || env.Path || env.path;
  if (!pathValue) return undefined;
  const pathApi = platform === "win32" ? path.win32 : path;
  const extensions = platform === "win32"
    ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExtension = platform === "win32" && Boolean(pathApi.extname(command));
  for (const rawDirectory of pathValue.split(pathApi.delimiter)) {
    const directory = rawDirectory.replace(/^"|"$/g, "") || ".";
    for (const extension of hasExtension ? [""] : extensions) {
      const candidate = pathApi.resolve(directory, `${command}${extension.toLowerCase()}`);
      try {
        accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
        return candidate;
      } catch {
        // Keep searching the same way the shell would search PATH.
      }
    }
  }
  return undefined;
}

function findCodexAncestor(parentPid, platform, inspect, preferDesktop) {
  let pid = parentPid;
  let firstCodexExecutable;
  const visited = new Set();
  for (let depth = 0; depth < MAX_ANCESTORS && Number.isInteger(pid) && pid > 0 && !visited.has(pid); depth += 1) {
    visited.add(pid);
    const entry = inspect(pid, platform);
    if (!entry) return firstCodexExecutable;
    if (isCodexExecutable(entry.executable)) {
      firstCodexExecutable ||= entry.executable;
      if (!preferDesktop || isDesktopCodexExecutable(entry.executable)) return entry.executable;
    }
    pid = entry.parentPid;
  }
  return firstCodexExecutable;
}

export function resolveCodexRuntime({
  env = process.env,
  platform = process.platform,
  parentPid = process.ppid,
  inspect = inspectProcess,
  findExecutable = findExecutableOnPath
} = {}) {
  const originatorDesktop = /desktop/i.test(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "");
  const ancestorExecutable = findCodexAncestor(parentPid, platform, inspect, originatorDesktop);
  const desktop = originatorDesktop
    || isDesktopCodexExecutable(env.SYNOD_CODEX_BIN)
    || isDesktopCodexExecutable(ancestorExecutable);
  const surface = desktop ? "desktop" : "cli";
  if (env.SYNOD_CODEX_BIN) {
    return {
      surface,
      executable: env.SYNOD_CODEX_BIN,
      executableSource: "SYNOD_CODEX_BIN",
      resolved: true
    };
  }
  if (ancestorExecutable) {
    return {
      surface,
      executable: ancestorExecutable,
      executableSource: `${surface}-process`,
      resolved: true
    };
  }
  if (!desktop) {
    const executable = findExecutable("codex", env, platform);
    return executable
      ? { surface, executable, executableSource: "PATH", resolved: true }
      : { surface, executable: "codex", executableSource: "PATH-unresolved", resolved: false };
  }

  return { surface, executable: "codex", executableSource: "PATH-fallback", resolved: false };
}
