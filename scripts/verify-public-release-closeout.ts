import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  validateReleaseCloseoutFile,
  type ReleaseCloseoutValidationResult,
} from "./validate-release-closeout.js";
import { isRecord, parseJson, type UnknownRecord } from "../src/validation.js";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const SHA = /^[0-9a-f]{40}$/;
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;

export interface RecordedNpmPublication {
  package: string;
  version: string;
  gitHead: string;
  latest: string;
  integrity: string;
  attestationUrl: string;
  provenancePredicateType: string;
}

export interface LiveNpmPublication extends RecordedNpmPublication {}

export interface RecordedGitHubRelease {
  tag: string;
  url: string;
  publishedAt: string;
  isDraft: boolean;
  isPrerelease: boolean;
  isImmutable: boolean;
  isLatest: boolean;
}

export interface LiveGitHubRelease extends RecordedGitHubRelease {}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options?: CommandRunnerOptions,
) => string;

export interface CommandRunnerOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PublicApiEnvironmentScope {
  environment: NodeJS.ProcessEnv;
  cleanup: () => void;
}

export interface PublicPackageCommandEnvironmentScope {
  environment: NodeJS.ProcessEnv;
  cwd: string;
  cleanup: () => void;
}

export interface PublicReleaseCloseoutVerificationOptions {
  filePath: string;
  expectedPackage: string;
  expectedVersion: string;
  expectedTag: string;
  expectedTagSha: string;
  repository: string;
  commandRunner?: CommandRunner;
  registry?: string;
}

export interface PublicReleaseCloseoutVerificationResult {
  closeout: ReleaseCloseoutValidationResult;
  npm: LiveNpmPublication;
  githubRelease: LiveGitHubRelease;
  registryInstallVersion: string;
  publicCliVersion: string;
}

export class PublicReleaseVerificationError extends Error {
  readonly code = "SYNOD_PUBLIC_RELEASE_CLOSEOUT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "PublicReleaseVerificationError";
  }
}

function fail(message: string): never {
  throw new PublicReleaseVerificationError(message);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) fail(`${label} must be a JSON object.`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string.`);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} must be a boolean.`);
  return value;
}

function defaultCommandRunner(command: string, args: readonly string[], options: CommandRunnerOptions = {}): string {
  const execOptions: {
    cwd?: string;
    encoding: "utf8";
    env?: NodeJS.ProcessEnv;
    stdio: ["ignore", "pipe", "pipe"];
  } = {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  if (options.cwd !== undefined) execOptions.cwd = options.cwd;
  if (options.env !== undefined) execOptions.env = options.env;
  try {
    return execFileSync(command, [...args], execOptions);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Read-only command ${command} failed: ${detail}`);
  }
}

export function publicApiEnvironment(environment: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!environment.GH_TOKEN) fail("GH_TOKEN is required for read-only GitHub API verification.");
  const env: NodeJS.ProcessEnv = {};
  if (environment.PATH !== undefined) env.PATH = environment.PATH;
  env.GH_TOKEN = environment.GH_TOKEN;
  if (environment.GH_HOST !== undefined) env.GH_HOST = environment.GH_HOST;
  return env;
}

function isInside(directory: string, parent: string): boolean {
  const candidate = path.resolve(directory);
  const ancestor = path.resolve(parent);
  return candidate === ancestor || candidate.startsWith(`${ancestor}${path.sep}`);
}

export function createPublicApiEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PublicApiEnvironmentScope {
  const baseEnvironment = publicApiEnvironment(environment);
  const temporaryDirectories: string[] = [];
  const checkoutDirectory = process.cwd();
  try {
    const stateHome = mkdtempSync(path.join(os.tmpdir(), "synod-gh-state-"));
    temporaryDirectories.push(stateHome);
    const configHome = mkdtempSync(path.join(os.tmpdir(), "synod-gh-config-"));
    temporaryDirectories.push(configHome);
    if (isInside(stateHome, checkoutDirectory) || isInside(configHome, checkoutDirectory)) {
      throw new Error("GitHub API configuration directories must be outside the checkout.");
    }
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    return {
      environment: {
        ...baseEnvironment,
        XDG_STATE_HOME: stateHome,
        XDG_CONFIG_HOME: configHome,
      },
      cleanup,
    };
  } catch (error) {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

/**
 * Build a clean package-manager environment for public, unauthenticated reads.
 *
 * The caller's environment is deliberately not forwarded: npm and pnpm can
 * interpret credentials and registry configuration from environment variables
 * before command-line options are considered. The only inherited executable
 * setting is PATH; all user/config/cache homes are fresh temporary paths.
 */
export function createPublicPackageCommandEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): PublicPackageCommandEnvironmentScope {
  const checkoutDirectory = process.cwd();
  const temporaryDirectories: string[] = [];
  try {
    const root = mkdtempSync(path.join(os.tmpdir(), "synod-public-package-env-"));
    temporaryDirectories.push(root);
    if (isInside(root, checkoutDirectory)) {
      throw new Error("Public package-manager directories must be outside the checkout.");
    }
    const home = path.join(root, "home");
    const stateHome = path.join(root, "state");
    const configHome = path.join(root, "config");
    const cache = path.join(root, "cache");
    for (const directory of [home, stateHome, configHome, cache]) mkdirSync(directory);
    const cleanEnvironment: NodeJS.ProcessEnv = {};
    if (environment.PATH !== undefined) cleanEnvironment.PATH = environment.PATH;
    cleanEnvironment.HOME = home;
    cleanEnvironment.XDG_STATE_HOME = stateHome;
    cleanEnvironment.XDG_CONFIG_HOME = configHome;
    cleanEnvironment.npm_config_cache = cache;
    let cleaned = false;
    const cleanup = (): void => {
      if (cleaned) return;
      cleaned = true;
      for (const directory of temporaryDirectories) {
        rmSync(directory, { recursive: true, force: true });
      }
    };
    return { environment: cleanEnvironment, cwd: root, cleanup };
  } catch (error) {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    throw error;
  }
}

function parseCommandJson(output: string, label: string): UnknownRecord {
  try {
    return record(parseJson(output), label);
  } catch (error) {
    if (error instanceof PublicReleaseVerificationError) throw error;
    fail(`${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readCloseoutEvidence(filePath: string): {
  npm: RecordedNpmPublication;
  githubRelease: RecordedGitHubRelease;
} {
  let value: unknown;
  try {
    value = parseJson(readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(`Could not read or parse ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const closeout = record(value, "release closeout");
  const publication = record(closeout.publicVerification, "publicVerification");
  const npm = record(publication.npm, "publicVerification.npm");
  const registryPackage = record(publication.registryInstalledPackage, "registryInstalledPackage");
  const dist = record(registryPackage.dist, "registryInstalledPackage.dist");
  const attestations = record(dist.attestations, "registryInstalledPackage.dist.attestations");
  const provenance = record(attestations.provenance, "registryInstalledPackage.dist.attestations.provenance");
  const githubRelease = record(publication.githubRelease, "publicVerification.githubRelease");
  return {
    npm: {
      package: stringValue(npm.package, "publicVerification.npm.package"),
      version: stringValue(npm.version, "publicVerification.npm.version"),
      gitHead: stringValue(npm.gitHead, "publicVerification.npm.gitHead"),
      latest: stringValue(npm.latest, "publicVerification.npm.latest"),
      integrity: stringValue(dist.integrity, "registryInstalledPackage.dist.integrity"),
      attestationUrl: stringValue(attestations.url, "registryInstalledPackage.dist.attestations.url"),
      provenancePredicateType: stringValue(
        provenance.predicateType,
        "registryInstalledPackage.dist.attestations.provenance.predicateType",
      ),
    },
    githubRelease: {
      tag: stringValue(githubRelease.tag, "publicVerification.githubRelease.tag"),
      url: stringValue(githubRelease.url, "publicVerification.githubRelease.url"),
      publishedAt: stringValue(githubRelease.publishedAt, "publicVerification.githubRelease.publishedAt"),
      isDraft: booleanValue(githubRelease.isDraft, "publicVerification.githubRelease.isDraft"),
      isPrerelease: booleanValue(githubRelease.isPrerelease, "publicVerification.githubRelease.isPrerelease"),
      isImmutable: booleanValue(githubRelease.isImmutable, "publicVerification.githubRelease.isImmutable"),
      isLatest: booleanValue(githubRelease.isLatest, "publicVerification.githubRelease.isLatest"),
    },
  };
}

export function compareNpmPublication(
  recorded: RecordedNpmPublication,
  live: LiveNpmPublication,
): string[] {
  const mismatches: string[] = [];
  const fields: Array<keyof RecordedNpmPublication> = [
    "package",
    "version",
    "gitHead",
    "latest",
    "integrity",
    "attestationUrl",
    "provenancePredicateType",
  ];
  for (const field of fields) {
    if (recorded[field] !== live[field]) {
      mismatches.push(`npm ${field} differs (recorded ${JSON.stringify(recorded[field])}, live ${JSON.stringify(live[field])})`);
    }
  }
  return mismatches;
}

export function compareGitHubRelease(
  recorded: RecordedGitHubRelease,
  live: LiveGitHubRelease,
): string[] {
  const mismatches: string[] = [];
  const fields: Array<keyof RecordedGitHubRelease> = [
    "tag",
    "url",
    "publishedAt",
    "isDraft",
    "isPrerelease",
    "isImmutable",
    "isLatest",
  ];
  for (const field of fields) {
    if (recorded[field] !== live[field]) {
      mismatches.push(`GitHub release ${field} differs (recorded ${JSON.stringify(recorded[field])}, live ${JSON.stringify(live[field])})`);
    }
  }
  return mismatches;
}

function assertNoMismatches(label: string, mismatches: readonly string[]): void {
  if (mismatches.length > 0) fail(`${label} does not match live public evidence: ${mismatches.join("; ")}`);
}

export function collectLiveNpmPublication(
  packageName: string,
  version: string,
  commandRunner: CommandRunner = defaultCommandRunner,
): LiveNpmPublication {
  const packageEnvironment = createPublicPackageCommandEnvironment();
  try {
    const metadata = parseCommandJson(
      commandRunner("npm", [
        "view",
        `${packageName}@${version}`,
        "version",
        "gitHead",
        "dist-tags.latest",
        "dist.integrity",
        "dist.attestations",
        "--json",
        "--prefer-online",
        "--registry",
        DEFAULT_REGISTRY,
      ], { cwd: packageEnvironment.cwd, env: packageEnvironment.environment }),
      "npm view",
    );
    const attestations = record(metadata["dist.attestations"], "npm dist.attestations");
    const provenance = record(attestations.provenance, "npm dist.attestations.provenance");
    return {
      package: packageName,
      version: stringValue(metadata.version, "npm version"),
      gitHead: stringValue(metadata.gitHead, "npm gitHead"),
      latest: stringValue(metadata["dist-tags.latest"], "npm dist-tags.latest"),
      integrity: stringValue(metadata["dist.integrity"], "npm dist.integrity"),
      attestationUrl: stringValue(attestations.url, "npm dist.attestations.url"),
      provenancePredicateType: stringValue(provenance.predicateType, "npm provenance.predicateType"),
    };
  } finally {
    packageEnvironment.cleanup();
  }
}

function repositoryPath(repository: string): string {
  if (!/^[^/]+\/[^/]+$/.test(repository)) fail("repository must be an owner/name pair.");
  return repository;
}

export function collectLiveGitHubRelease(
  repository: string,
  tag: string,
  commandRunner: CommandRunner = defaultCommandRunner,
): LiveGitHubRelease {
  if (!STABLE_TAG.test(tag)) fail("tag must be a stable v<version> tag.");
  const repo = repositoryPath(repository);
  const apiEnvironment = createPublicApiEnvironment();
  try {
    const release = parseCommandJson(
      commandRunner("gh", [
        "api",
        `repos/${repo}/releases/tags/${tag}`,
        "--header",
        "Accept: application/vnd.github+json",
      ], { env: apiEnvironment.environment }),
      "GitHub release API",
    );
    const latest = parseCommandJson(
      commandRunner("gh", [
        "api",
        `repos/${repo}/releases/latest`,
        "--header",
        "Accept: application/vnd.github+json",
      ], { env: apiEnvironment.environment }),
      "GitHub latest release API",
    );
    const latestTag = stringValue(latest.tag_name, "GitHub latest tag");
    return {
      tag: stringValue(release.tag_name, "GitHub release tag"),
      url: stringValue(release.html_url, "GitHub release URL"),
      publishedAt: stringValue(release.published_at, "GitHub release publishedAt"),
      isDraft: booleanValue(release.draft, "GitHub release draft"),
      isPrerelease: booleanValue(release.prerelease, "GitHub release prerelease"),
      isImmutable: booleanValue(release.immutable, "GitHub release immutable"),
      isLatest: latestTag === tag,
    };
  } finally {
    apiEnvironment.cleanup();
  }
}

function versionOutput(output: string, label: string, expectedVersion: string): string {
  const version = output.trim();
  if (version !== expectedVersion) {
    fail(`${label} returned ${JSON.stringify(version)}, expected ${JSON.stringify(expectedVersion)}.`);
  }
  return version;
}

export function verifyExactRegistryInstall(
  packageSpec: string,
  expectedVersion: string,
  commandRunner: CommandRunner = defaultCommandRunner,
  registry = DEFAULT_REGISTRY,
): string {
  if (registry !== DEFAULT_REGISTRY) fail(`Registry verification must use ${DEFAULT_REGISTRY}.`);
  const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "synod-public-closeout-"));
  let packageEnvironment: PublicPackageCommandEnvironmentScope | undefined;
  try {
    packageEnvironment = createPublicPackageCommandEnvironment();
    writeFileSync(
      path.join(temporaryDirectory, "package.json"),
      JSON.stringify({ name: "synod-public-closeout-consumer", private: true }) + "\n",
      "utf8",
    );
    commandRunner("pnpm", [
      "add",
      "--ignore-scripts",
      "--save-exact",
      "--registry",
      DEFAULT_REGISTRY,
      packageSpec,
    ], { cwd: temporaryDirectory, env: packageEnvironment.environment });
    return versionOutput(
      commandRunner("pnpm", ["exec", "synod", "--version"], {
        cwd: temporaryDirectory,
        env: packageEnvironment.environment,
      }),
      "clean registry install",
      expectedVersion,
    );
  } finally {
    packageEnvironment?.cleanup();
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

export function verifyPublicDlx(
  packageSpec: string,
  expectedVersion: string,
  commandRunner: CommandRunner = defaultCommandRunner,
): string {
  const packageEnvironment = createPublicPackageCommandEnvironment();
  try {
    return versionOutput(
      commandRunner("pnpm", [
        "dlx",
        `--config.registry=${DEFAULT_REGISTRY}`,
        packageSpec,
        "--version",
      ], {
        cwd: packageEnvironment.cwd,
        env: packageEnvironment.environment,
      }),
      "public pnpm dlx",
      expectedVersion,
    );
  } finally {
    packageEnvironment.cleanup();
  }
}

export function verifyPublicReleaseCloseout(
  options: PublicReleaseCloseoutVerificationOptions,
): PublicReleaseCloseoutVerificationResult {
  if (!SHA.test(options.expectedTagSha)) fail("expectedTagSha must be a lowercase 40-character Git SHA.");
  if (!STABLE_TAG.test(options.expectedTag)) fail("expectedTag must be a stable v<version> tag.");
  const closeout = validateReleaseCloseoutFile(options.filePath, {
    phase: "post-publication",
    expectedPackage: options.expectedPackage,
    expectedVersion: options.expectedVersion,
    expectedTag: options.expectedTag,
    expectedTagSha: options.expectedTagSha,
  });
  const recorded = readCloseoutEvidence(options.filePath);
  const commandRunner = options.commandRunner ?? defaultCommandRunner;
  const liveNpm = collectLiveNpmPublication(options.expectedPackage, options.expectedVersion, commandRunner);
  assertNoMismatches("npm publication", compareNpmPublication(recorded.npm, liveNpm));
  const liveGitHubRelease = collectLiveGitHubRelease(options.repository, options.expectedTag, commandRunner);
  assertNoMismatches("GitHub release", compareGitHubRelease(recorded.githubRelease, liveGitHubRelease));
  const registryInstallVersion = verifyExactRegistryInstall(
    recorded.npm.package + "@" + recorded.npm.version,
    options.expectedVersion,
    commandRunner,
    options.registry ?? DEFAULT_REGISTRY,
  );
  const publicCliVersion = verifyPublicDlx(
    recorded.npm.package + "@" + recorded.npm.version,
    options.expectedVersion,
    commandRunner,
  );
  return {
    closeout,
    npm: liveNpm,
    githubRelease: liveGitHubRelease,
    registryInstallVersion,
    publicCliVersion,
  };
}

interface CliOptions {
  filePath: string;
  expectedPackage?: string;
  expectedVersion?: string;
  expectedTag: string;
  expectedTagSha: string;
  repository: string;
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
  const unsupported = [...values.keys()].filter(key => ![
    "file", "package", "version", "tag", "tag-sha", "repository",
  ].includes(key));
  if (unsupported.length > 0) fail(`Unknown option --${unsupported[0]}.`);
  const expectedTag = values.get("tag");
  const expectedTagSha = values.get("tag-sha");
  const repository = values.get("repository") ?? process.env.GITHUB_REPOSITORY;
  const expectedPackage = values.get("package");
  const expectedVersion = values.get("version");
  if (!expectedTag) fail("--tag is required.");
  if (!expectedTagSha) fail("--tag-sha is required.");
  if (!repository) fail("--repository or GITHUB_REPOSITORY is required.");
  return {
    filePath: path.resolve(values.get("file") ?? "RELEASE-CLOSEOUT.json"),
    ...(expectedPackage === undefined ? {} : { expectedPackage }),
    ...(expectedVersion === undefined ? {} : { expectedVersion }),
    expectedTag,
    expectedTagSha,
    repository,
    json,
  };
}

function runCli(argv: string[]): number {
  let json = argv.includes("--json");
  try {
    const cli = cliOptions(argv);
    json = cli.json;
    const packagePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../package.json");
    const packageJson = record(parseJson(readFileSync(packagePath, "utf8")), "package.json");
    const expectedPackage = cli.expectedPackage ?? stringValue(packageJson.name, "package.json.name");
    const expectedVersion = cli.expectedVersion ?? stringValue(packageJson.version, "package.json.version");
    const result = verifyPublicReleaseCloseout({
      filePath: cli.filePath,
      expectedPackage,
      expectedVersion,
      expectedTag: cli.expectedTag,
      expectedTagSha: cli.expectedTagSha,
      repository: cli.repository,
    });
    const output = { ok: true, ...result };
    process.stdout.write(json ? `${JSON.stringify(output)}\n` : `${result.closeout.tag}: verified ${result.closeout.package}@${result.closeout.version}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (json) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: "SYNOD_PUBLIC_RELEASE_CLOSEOUT_INVALID", message } })}\n`);
    else process.stderr.write(`${message}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
