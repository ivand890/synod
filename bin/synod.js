#!/usr/bin/env node

import { errorEnvelope } from "../dist/contracts.js";
import { asSynodError, withErrorDetails } from "../dist/errors.js";
import { prepareLocalRuntime, removeLocalRuntime } from "../dist/local-runtime.js";
import { run } from "../dist/cli.js";

const args = process.argv.slice(2);
const jsonRequested = args.includes("--json");
const command = args[0] && !args[0].startsWith("-") ? args[0] : null;

function bufferedConsole() {
  /** @type {Array<{ method: "log" | "warn" | "error"; values: unknown[] }>} */
  const entries = [];
  /** @type {Record<"log" | "warn" | "error", (...values: unknown[]) => void>} */
  const output = {
    log: (...values) => { entries.push({ method: "log", values }); },
    warn: (...values) => { entries.push({ method: "warn", values }); },
    error: (...values) => { entries.push({ method: "error", values }); }
  };
  return {
    output,
    flush() {
      for (const entry of entries) console[entry.method](...entry.values);
    }
  };
}

try {
  const runtime = await prepareLocalRuntime(args);
  if (runtime.action === "delegate") {
    process.exitCode = runtime.status;
  } else {
    const removesRuntime = runtime.local && command === "uninstall" && !args.includes("--dry-run");
    const buffer = removesRuntime ? bufferedConsole() : undefined;
    const status = await run(args, buffer?.output || console, {
      ...(runtime.runtimePlan ? { localRuntimePlan: runtime.runtimePlan } : {})
    });
    if (status === 0 && removesRuntime) {
      try {
        if (!runtime.targetDirectory) throw new Error("Local runtime removal is missing its target directory.");
        await removeLocalRuntime(runtime.targetDirectory);
      } catch (error) {
        if (!jsonRequested) buffer?.flush();
        throw withErrorDetails(error, {
          projectUninstall: "completed",
          runtimeRemoval: "failed"
        });
      }
    }
    buffer?.flush();
    process.exitCode = status;
  }
} catch (error) {
  const value = asSynodError(error);
  if (jsonRequested) {
    console.log(JSON.stringify(errorEnvelope(command, value), null, 2));
  } else {
    console.error(`Error [${value.code}]: ${value.message}`);
    console.error("Run `synod --help` for usage.");
  }
  process.exitCode = 1;
}
