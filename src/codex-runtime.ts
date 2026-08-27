import { accessSync, constants, readFileSync, readlinkSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

const MAX_ANCESTORS = 8;

export interface ProcessEntry {
  parentPid: number;
  executable: string;
}

export interface ResolvedCodexRuntime {
  surface: "desktop" | "cli";
  executable: string;
  executableSource: string;
  resolved: boolean;
  /** True when this process is running under a Codex host, independent of which executable will be launched. */
  hostOperator?: boolean;
}

export type ProcessInspector = (pid: number, platform: NodeJS.Platform) => ProcessEntry | undefined;
export type ExecutableFinder = (command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => string | undefined;

function inspectUnixProcess(pid: number): ProcessEntry | undefined {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "ppid=,comm="], {
    encoding: "utf8",
    timeout: 1_000
  });
  if (result.error || result.status !== 0) return undefined;
  const match = result.stdout.trim().match(/^(\d+)\s+(.+)$/);
  const parentPid = match?.[1];
  const executable = match?.[2];
  return parentPid && executable ? { parentPid: Number(parentPid), executable: executable.trim() } : undefined;
}

function inspectLinuxProcess(pid: number): ProcessEntry | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    const parentPid = fields[1];
    if (!parentPid) return undefined;
    return { parentPid: Number(parentPid), executable: readlinkSync(`/proc/${pid}/exe`) };
  } catch {
    return undefined;
  }
}

function inspectWindowsProcess(pid: number): ProcessEntry | undefined {
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
  const parentPid = match?.[1];
  const executable = match?.[2];
  return parentPid && executable ? { parentPid: Number(parentPid), executable: executable.trim() } : undefined;
}

function inspectProcess(pid: number, platform: NodeJS.Platform): ProcessEntry | undefined {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (platform === "linux") return inspectLinuxProcess(pid);
  if (platform === "win32") return inspectWindowsProcess(pid);
  return inspectUnixProcess(pid);
}

function isCodexExecutable(value: string | undefined): boolean {
  return ["codex", "codex.exe"].includes(path.basename(value || "").toLowerCase());
}

function isDesktopCodexExecutable(value: string | undefined): boolean {
  const normalized = String(value || "").replaceAll("\\", "/").toLowerCase();
  return normalized.includes(".app/contents/resources/codex")
    || normalized.includes("/chatgpt/")
    || normalized.includes("/chatgpt.app/");
}

function findExecutableOnPath(command: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
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

function findCodexAncestor(
  parentPid: number,
  platform: NodeJS.Platform,
  inspect: ProcessInspector,
  preferDesktop: boolean
): string | undefined {
  let pid = parentPid;
  let firstCodexExecutable;
  const visited = new Set<number>();
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
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  parentPid?: number;
  inspect?: ProcessInspector;
  findExecutable?: ExecutableFinder;
} = {}): ResolvedCodexRuntime {
  const originatorDesktop = /desktop/i.test(env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE || "");
  const ancestorExecutable = findCodexAncestor(parentPid, platform, inspect, originatorDesktop);
  const desktop = originatorDesktop
    || isDesktopCodexExecutable(env.SYNOD_CODEX_BIN)
    || isDesktopCodexExecutable(ancestorExecutable);
  const surface = desktop ? "desktop" : "cli";
  const hostOperator = desktop || Boolean(ancestorExecutable);
  if (env.SYNOD_CODEX_BIN) {
    return {
      surface,
      executable: env.SYNOD_CODEX_BIN,
      executableSource: "SYNOD_CODEX_BIN",
      resolved: true,
      hostOperator
    };
  }
  if (ancestorExecutable) {
    return {
      surface,
      executable: ancestorExecutable,
      executableSource: `${surface}-process`,
      resolved: true,
      hostOperator
    };
  }
  if (!desktop) {
    const executable = findExecutable("codex", env, platform);
    return executable
      ? { surface, executable, executableSource: "PATH", resolved: true, hostOperator }
      : { surface, executable: "codex", executableSource: "PATH-unresolved", resolved: false, hostOperator };
  }

  return { surface, executable: "codex", executableSource: "PATH-fallback", resolved: false, hostOperator };
}
