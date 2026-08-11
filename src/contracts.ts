import process from "node:process";
import type { SynodError } from "./errors.js";
import { packageVersion } from "./package.js";

export const JSON_SCHEMA_VERSION = 1;

export const WARNING_CODES = Object.freeze({
  DURABLE_STATE_PRESERVED: "SYNOD_DURABLE_STATE_PRESERVED",
  USER_CONFIG_PRESERVED: "SYNOD_USER_CONFIG_PRESERVED",
  AGENTS_BLOCK_DUPLICATES_REPAIRED: "SYNOD_AGENTS_BLOCK_DUPLICATES_REPAIRED",
  PROJECT_UPGRADE_AVAILABLE: "SYNOD_PROJECT_UPGRADE_AVAILABLE",
  USER_OWNED_FILE_MISSING: "SYNOD_USER_OWNED_FILE_MISSING",
  PROFILE_INCOMPATIBLE: "SYNOD_PROFILE_INCOMPATIBLE",
  CODEX_VERSION_UNSUPPORTED: "SYNOD_CODEX_VERSION_UNSUPPORTED",
  APP_SERVER_FORCE_KILLED: "SYNOD_APP_SERVER_FORCE_KILLED",
  APP_SERVER_EXIT_UNCONFIRMED: "SYNOD_APP_SERVER_EXIT_UNCONFIRMED",
  APP_SERVER_EVENT_LISTENER_FAILED: "SYNOD_APP_SERVER_EVENT_LISTENER_FAILED",
  WAIT_CLEANUP_FAILED: "SYNOD_WAIT_CLEANUP_FAILED",
  BACKUP_CLEANUP_FAILED: "SYNOD_BACKUP_CLEANUP_FAILED",
  DIRECTORY_PRUNE_FAILED: "SYNOD_DIRECTORY_PRUNE_FAILED"
} as const);

export type WarningCode = typeof WARNING_CODES[keyof typeof WARNING_CODES];

export interface Warning {
  code: WarningCode;
  message: string;
  details?: unknown;
}

export interface Diagnostics extends Record<string, unknown> {
  synodVersion: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
}

export interface SuccessEnvelope<T> {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: true;
  command: string | null;
  data: T;
  warnings: Warning[];
  diagnostics: Diagnostics;
}

export interface ErrorEnvelope {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  ok: false;
  command: string | null;
  error: { code: string; message: string; details?: unknown };
  warnings: Warning[];
  diagnostics: Diagnostics;
}

export function warning(code: WarningCode, message: string, details?: unknown): Warning {
  return details === undefined ? { code, message } : { code, message, details };
}

export function baseDiagnostics(extra: Record<string, unknown> = {}): Diagnostics {
  return {
    ...extra,
    synodVersion: packageVersion,
    nodeVersion: process.versions.node,
    platform: process.platform
  };
}

export function successEnvelope<T>(
  command: string | null,
  data: T,
  { warnings = [], diagnostics = {} }: { warnings?: Warning[]; diagnostics?: Record<string, unknown> } = {}
): SuccessEnvelope<T> {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings,
    diagnostics: baseDiagnostics(diagnostics)
  };
}

export function errorEnvelope(
  command: string | null,
  error: SynodError,
  { warnings = [], diagnostics = {} }: { warnings?: Warning[]; diagnostics?: Record<string, unknown> } = {}
): ErrorEnvelope {
  const errorValue: ErrorEnvelope["error"] = {
    code: error.code,
    message: error.message
  };
  if (error.details !== undefined) errorValue.details = error.details;

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: false,
    command,
    error: errorValue,
    warnings,
    diagnostics: baseDiagnostics(diagnostics)
  };
}
