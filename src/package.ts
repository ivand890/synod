import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isRecord, parseJson } from "./validation.js";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = parseJson(readFileSync(packagePath, "utf8"));

if (
  !isRecord(packageJson)
  || typeof packageJson.version !== "string"
  || typeof packageJson.name !== "string"
  || typeof packageJson.packageManager !== "string"
) {
  throw new TypeError("Synod package metadata is invalid.");
}

export const packageVersion = packageJson.version;
export const packageName = packageJson.name;
export const packageManager = packageJson.packageManager;
