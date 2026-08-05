import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));
const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));

export const packageVersion = packageJson.version;
