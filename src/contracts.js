import process from "node:process";
import { packageVersion } from "./package.js";

export const JSON_SCHEMA_VERSION = 1;

export const WARNING_CODES = Object.freeze({
  DURABLE_STATE_PRESERVED: "SYNOD_DURABLE_STATE_PRESERVED",
  USER_CONFIG_PRESERVED: "SYNOD_USER_CONFIG_PRESERVED",
  AGENTS_BLOCK_DUPLICATES_REPAIRED: "SYNOD_AGENTS_BLOCK_DUPLICATES_REPAIRED",
  APP_SERVER_FORCE_KILLED: "SYNOD_APP_SERVER_FORCE_KILLED",
  APP_SERVER_EXIT_UNCONFIRMED: "SYNOD_APP_SERVER_EXIT_UNCONFIRMED"
});

export function warning(code, message, details) {
  return details === undefined ? { code, message } : { code, message, details };
}

export function baseDiagnostics(extra = {}) {
  return {
    synodVersion: packageVersion,
    nodeVersion: process.versions.node,
    platform: process.platform,
    ...extra
  };
}

export function successEnvelope(command, data, { warnings = [], diagnostics = {} } = {}) {
  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    ok: true,
    command,
    data,
    warnings,
    diagnostics: baseDiagnostics(diagnostics)
  };
}

export function errorEnvelope(command, error, { warnings = [], diagnostics = {} } = {}) {
  const errorValue = {
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
