import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testDirectory = fileURLToPath(new URL("../test/", import.meta.url));
const testFiles = readdirSync(testDirectory)
  .filter(file => file.endsWith(".test.ts"))
  .sort()
  .map(file => path.join(testDirectory, file));

if (testFiles.length === 0) throw new Error("No TypeScript test files were found.");

const result = spawnSync(process.execPath, ["--import", "tsx", "--test", ...testFiles], {
  stdio: "inherit"
});

if (result.error) throw result.error;
if (result.status === null) {
  throw new Error(`Test runner exited without a status${result.signal ? ` after ${result.signal}` : ""}.`);
}
process.exitCode = result.status;
