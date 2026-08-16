import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord, parseJson, type UnknownRecord } from "../src/validation.js";

const PACKAGE_NAME = "@ivand890/synod";
const DOCUMENTATION_PATHS = ["README.md", "ROADMAP.md", "RELEASING.md"] as const;
const DOCUMENTATION_RULE = "Advance these paths together only when publicVerification is verified.";
const STABLE_VERSION = /^\d+\.\d+\.\d+$/;
const SHA = /^[0-9a-f]{40}$/;
const PHASES = ["pre-tag", "tag", "post-publication"] as const;

export type ReleaseCloseoutPhase = (typeof PHASES)[number];

export interface ReleaseCloseoutValidationOptions {
  phase: ReleaseCloseoutPhase;
  expectedPackage?: string;
  expectedVersion?: string;
  expectedTag?: string;
  expectedTagSha?: string;
}

export interface ReleaseCloseoutValidationResult {
  phase: ReleaseCloseoutPhase;
  package: string;
  version: string;
  tag: string;
  tagSha?: string;
}

export class ReleaseCloseoutValidationError extends Error {
  readonly code = "SYNOD_RELEASE_CLOSEOUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ReleaseCloseoutValidationError";
  }
}

function fail(message: string): never {
  throw new ReleaseCloseoutValidationError(message);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) fail(`${label} must be a JSON object.`);
  return value;
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): UnknownRecord {
  const result = record(value, label);
  const expected = new Set(keys);
  const unexpected = Object.keys(result).filter(key => !expected.has(key));
  const missing = keys.filter(key => !(key in result));
  if (unexpected.length > 0 || missing.length > 0) {
    const details = [
      ...(missing.length > 0 ? [`missing ${missing.join(", ")}`] : []),
      ...(unexpected.length > 0 ? [`unexpected ${unexpected.join(", ")}`] : []),
    ];
    fail(`${label} has an invalid shape (${details.join("; ")}).`);
  }
  return result;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function stableVersion(value: unknown, label: string): string {
  const version = stringValue(value, label);
  if (!STABLE_VERSION.test(version)) fail(`${label} must be a stable semantic version.`);
  return version;
}

function status(value: unknown, expected: string, label: string): void {
  if (value !== expected) fail(`${label} must be ${JSON.stringify(expected)}.`);
}

function sha(value: unknown, label: string): string {
  const valueString = stringValue(value, label);
  if (!SHA.test(valueString)) fail(`${label} must be a lowercase 40-character Git SHA.`);
  return valueString;
}

function noTagSha(value: UnknownRecord, label: string): void {
  if ("tagSha" in value) fail(`${label}.tagSha must be absent before the release tag exists.`);
}

function documentation(value: unknown, expectedStatus: "pending" | "verified"): void {
  const result = exactRecord(value, "documentation", ["status", "paths", "rule"]);
  status(result.status, expectedStatus, "documentation.status");
  if (!Array.isArray(result.paths) || result.paths.length !== DOCUMENTATION_PATHS.length
    || result.paths.some((item, index) => item !== DOCUMENTATION_PATHS[index])) {
    fail("documentation.paths must be the ordered README.md, ROADMAP.md, RELEASING.md set.");
  }
  if (result.rule !== DOCUMENTATION_RULE) fail("documentation.rule does not describe the strict phase transition.");
}

function localPackageSmoke(value: unknown, expectedStatus: "pending" | "passed", version: string): void {
  const result = exactRecord(value, "sourcePreparation.localPackageSmoke", ["artifact", "command", "status", "version"]);
  if (result.artifact !== "local tarball") fail("sourcePreparation.localPackageSmoke.artifact must be local tarball.");
  if (result.command !== "pnpm test:package") fail("sourcePreparation.localPackageSmoke.command must be pnpm test:package.");
  status(result.status, expectedStatus, "sourcePreparation.localPackageSmoke.status");
  if (result.version !== version) fail("sourcePreparation.localPackageSmoke.version must match the closeout version.");
}

function preTagSource(value: unknown, version: string): void {
  const result = exactRecord(value, "sourcePreparation", ["status", "mainAncestorRequired", "localPackageSmoke"]);
  status(result.status, "prepared", "sourcePreparation.status");
  if (!booleanValue(result.mainAncestorRequired, "sourcePreparation.mainAncestorRequired")) {
    fail("sourcePreparation.mainAncestorRequired must be true.");
  }
  localPackageSmoke(result.localPackageSmoke, "pending", version);
  noTagSha(result, "sourcePreparation");
}

function postPublicationSource(value: unknown, version: string, expectedTagSha: string): void {
  const result = exactRecord(value, "sourcePreparation", ["status", "tagSha", "mainAncestorRequired", "localPackageSmoke"]);
  status(result.status, "closed", "sourcePreparation.status");
  if (result.tagSha !== expectedTagSha) fail("sourcePreparation.tagSha must match the exact tagged commit.");
  sha(result.tagSha, "sourcePreparation.tagSha");
  if (!booleanValue(result.mainAncestorRequired, "sourcePreparation.mainAncestorRequired")) {
    fail("sourcePreparation.mainAncestorRequired must be true.");
  }
  localPackageSmoke(result.localPackageSmoke, "passed", version);
}

function integrity(value: unknown, packageName: string, version: string): void {
  const result = exactRecord(value, "publicVerification.registryInstalledPackage", [
    "spec", "dist", "consumerCommand", "verification", "status", "version",
  ]);
  if (result.spec !== `${packageName}@${version}`) fail("registryInstalledPackage.spec must match the exact registry package.");
  const dist = exactRecord(result.dist, "registryInstalledPackage.dist", ["integrity", "attestations"]);
  const integrityValue = stringValue(dist.integrity, "registryInstalledPackage.dist.integrity");
  const encoded = integrityValue.startsWith("sha512-") ? integrityValue.slice("sha512-".length) : "";
  const digest = Buffer.from(encoded, "base64");
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(integrityValue)
    || digest.length !== 64
    || digest.toString("base64") !== encoded) {
    fail("registryInstalledPackage.dist.integrity must be a canonical sha512 integrity value.");
  }
  const attestations = exactRecord(dist.attestations, "registryInstalledPackage.dist.attestations", ["url", "provenance"]);
  const expectedUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${encodeURIComponent(packageName).replace(/^%40/i, "@")}@${version}`;
  if (typeof attestations.url !== "string" || attestations.url.toLowerCase() !== expectedUrl.toLowerCase()) {
    fail("registryInstalledPackage.dist.attestations.url must match the exact registry package.");
  }
  const provenance = exactRecord(attestations.provenance, "registryInstalledPackage.dist.attestations.provenance", ["predicateType"]);
  if (provenance.predicateType !== "https://slsa.dev/provenance/v1") {
    fail("registryInstalledPackage.dist.attestations.provenance.predicateType must be SLSA provenance.");
  }
  if (result.consumerCommand !== `pnpm add --ignore-scripts --save-exact ${packageName}@${version}`) {
    fail("registryInstalledPackage.consumerCommand must install the exact registry spec.");
  }
  const verification = exactRecord(result.verification, "registryInstalledPackage.verification", ["command", "status", "version"]);
  if (verification.command !== "pnpm exec synod --version" || verification.status !== "passed" || verification.version !== version) {
    fail("registryInstalledPackage.verification must prove the exact installed CLI version.");
  }
  if (result.status !== "passed" || result.version !== version) fail("registryInstalledPackage status/version evidence is incomplete.");
}

function publicPublication(value: unknown, packageName: string, version: string, tag: string, expectedTagSha: string): void {
  const result = exactRecord(value, "publicVerification", [
    "status", "tagSha", "npm", "githubRelease", "registryInstalledPackage", "publicCli",
  ]);
  status(result.status, "verified", "publicVerification.status");
  if (result.tagSha !== expectedTagSha) fail("publicVerification.tagSha must match the exact tagged commit.");
  sha(result.tagSha, "publicVerification.tagSha");
  const npm = exactRecord(result.npm, "publicVerification.npm", ["package", "version", "gitHead", "latest"]);
  if (npm.package !== packageName || npm.version !== version || npm.gitHead !== expectedTagSha || npm.latest !== version) {
    fail("publicVerification.npm must bind the exact published package, Git commit, and latest version.");
  }
  const githubRelease = exactRecord(result.githubRelease, "publicVerification.githubRelease", [
    "tag", "url", "publishedAt", "isDraft", "isPrerelease", "isImmutable", "isLatest",
  ]);
  if (githubRelease.tag !== tag
    || githubRelease.url !== `https://github.com/ivand890/synod/releases/tag/${tag}`
    || typeof githubRelease.publishedAt !== "string"
    || !Number.isFinite(Date.parse(githubRelease.publishedAt))
    || githubRelease.isDraft !== false
    || githubRelease.isPrerelease !== false
    || githubRelease.isImmutable !== true
    || githubRelease.isLatest !== true) {
    fail("publicVerification.githubRelease must be an exact immutable published latest release.");
  }
  integrity(result.registryInstalledPackage, packageName, version);
  const publicCli = exactRecord(result.publicCli, "publicVerification.publicCli", ["command", "status", "version"]);
  if (publicCli.command !== `pnpm dlx ${packageName}@${version} --version` || publicCli.status !== "passed" || publicCli.version !== version) {
    fail("publicVerification.publicCli must prove the exact public CLI version.");
  }
}

function pendingPublication(value: unknown): void {
  const result = exactRecord(value, "publicVerification", ["status"]);
  status(result.status, "pending", "publicVerification.status");
  noTagSha(result, "publicVerification");
}

export function validateReleaseCloseout(
  value: unknown,
  options: ReleaseCloseoutValidationOptions,
): ReleaseCloseoutValidationResult {
  if (!PHASES.includes(options.phase)) fail(`phase must be one of ${PHASES.join(", ")}.`);
  const closeout = exactRecord(value, "release closeout", [
    "schemaVersion", "package", "version", "tag", "sourcePreparation", "publicVerification", "documentation",
  ]);
  if (closeout.schemaVersion !== 1) fail("schemaVersion must be 1.");
  const packageName = stringValue(closeout.package, "package");
  const version = stableVersion(closeout.version, "version");
  const tag = stringValue(closeout.tag, "tag");
  if (packageName !== (options.expectedPackage ?? PACKAGE_NAME)) fail("package is not the expected Synod package.");
  if (version !== options.expectedVersion && options.expectedVersion !== undefined) fail("version does not match the package manifest.");
  if (tag !== `v${version}`) fail("tag must be v<version>.");
  if (options.expectedTag !== undefined && tag !== options.expectedTag) fail("tag does not match the release ref.");
  const expectedTagSha = options.expectedTagSha;
  if (expectedTagSha !== undefined) sha(expectedTagSha, "expectedTagSha");

  if (options.phase === "pre-tag" || options.phase === "tag") {
    preTagSource(closeout.sourcePreparation, version);
    pendingPublication(closeout.publicVerification);
    documentation(closeout.documentation, "pending");
    if (options.phase === "tag" && expectedTagSha === undefined) fail("tag phase requires the authenticated tagged commit SHA.");
    return { phase: options.phase, package: packageName, version, tag };
  }

  if (expectedTagSha === undefined) fail("post-publication phase requires the authenticated tagged commit SHA.");
  postPublicationSource(closeout.sourcePreparation, version, expectedTagSha);
  publicPublication(closeout.publicVerification, packageName, version, tag, expectedTagSha);
  documentation(closeout.documentation, "verified");
  return { phase: options.phase, package: packageName, version, tag, tagSha: expectedTagSha };
}

export function validateReleaseCloseoutFile(
  filePath: string,
  options: ReleaseCloseoutValidationOptions,
): ReleaseCloseoutValidationResult {
  let parsed: unknown;
  try {
    parsed = parseJson(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Could not read or parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return validateReleaseCloseout(parsed, options);
}

interface CliOptions {
  file: string;
  phase: ReleaseCloseoutPhase;
  expectedPackage?: string;
  expectedVersion?: string;
  expectedTag?: string;
  expectedTagSha?: string;
  json: boolean;
}

function cliOptions(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (!arg?.startsWith("--")) fail(`Unknown argument ${arg ?? ""}.`);
    const key = arg.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) fail(`Option --${key} requires a value.`);
    if (values.has(key)) fail(`Option --${key} was supplied more than once.`);
    values.set(key, value);
    index += 1;
  }
  const phase = values.get("phase") ?? "pre-tag";
  if (!PHASES.includes(phase as ReleaseCloseoutPhase)) fail(`--phase must be one of ${PHASES.join(", ")}.`);
  const unsupported = [...values.keys()].filter(key => ![
    "file", "phase", "package", "version", "tag", "tag-sha",
  ].includes(key));
  if (unsupported.length > 0) fail(`Unknown option --${unsupported[0]}.`);
  return {
    file: path.resolve(values.get("file") ?? "RELEASE-CLOSEOUT.json"),
    phase: phase as ReleaseCloseoutPhase,
    ...(values.has("package") ? { expectedPackage: values.get("package")! } : {}),
    ...(values.has("version") ? { expectedVersion: values.get("version")! } : {}),
    ...(values.has("tag") ? { expectedTag: values.get("tag")! } : {}),
    ...(values.has("tag-sha") ? { expectedTagSha: values.get("tag-sha")! } : {}),
    json,
  };
}

function runCli(argv: string[]): number {
  try {
    const cli = cliOptions(argv);
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    const packageJson = record(parseJson(readFileSync(packagePath, "utf8")), "package.json");
    const result = validateReleaseCloseoutFile(cli.file, {
      phase: cli.phase,
      expectedPackage: cli.expectedPackage ?? stringValue(packageJson.name, "package.json.name"),
      expectedVersion: cli.expectedVersion ?? stableVersion(packageJson.version, "package.json.version"),
      ...(cli.expectedTag !== undefined ? { expectedTag: cli.expectedTag } : {}),
      ...(cli.expectedTagSha !== undefined ? { expectedTagSha: cli.expectedTagSha } : {}),
    });
    const output = { ok: true, ...result };
    process.stdout.write(cli.json ? `${JSON.stringify(output)}\n` : `${result.phase}: ${result.package}@${result.version} ${result.tag}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "SYNOD_RELEASE_CLOSEOUT_INVALID", message } })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
