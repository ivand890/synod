export const ERROR_CODES = Object.freeze({
  UNKNOWN_COMMAND: "SYNOD_UNKNOWN_COMMAND",
  UNKNOWN_OPTION: "SYNOD_UNKNOWN_OPTION",
  MISSING_OPTION_VALUE: "SYNOD_MISSING_OPTION_VALUE",
  UNEXPECTED_ARGUMENT: "SYNOD_UNEXPECTED_ARGUMENT",
  TARGET_NOT_FOUND: "SYNOD_TARGET_NOT_FOUND",
  TARGET_NOT_DIRECTORY: "SYNOD_TARGET_NOT_DIRECTORY",
  INIT_CONFLICT: "SYNOD_INIT_CONFLICT",
  AGENTS_BLOCK_MALFORMED: "SYNOD_AGENTS_BLOCK_MALFORMED",
  SESSION_NOT_FOUND: "SYNOD_SESSION_NOT_FOUND",
  SESSION_CYCLE: "SYNOD_SESSION_CYCLE",
  ROLLOUT_PATH_MISSING: "SYNOD_ROLLOUT_PATH_MISSING",
  APP_SERVER_NOT_RUNNING: "SYNOD_APP_SERVER_NOT_RUNNING",
  APP_SERVER_SPAWN_FAILED: "SYNOD_APP_SERVER_SPAWN_FAILED",
  APP_SERVER_TIMEOUT: "SYNOD_APP_SERVER_TIMEOUT",
  APP_SERVER_EXITED: "SYNOD_APP_SERVER_EXITED",
  APP_SERVER_MALFORMED_OUTPUT: "SYNOD_APP_SERVER_MALFORMED_OUTPUT",
  APP_SERVER_PROTOCOL_ERROR: "SYNOD_APP_SERVER_PROTOCOL_ERROR",
  APP_SERVER_UNSUPPORTED: "SYNOD_APP_SERVER_UNSUPPORTED",
  INTERNAL: "SYNOD_INTERNAL_ERROR"
});

export class SynodError extends Error {
  constructor(code, message, { cause, details } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "SynodError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function asSynodError(error, fallbackCode = ERROR_CODES.INTERNAL) {
  if (error instanceof SynodError) return error;
  return new SynodError(fallbackCode, error?.message || String(error), { cause: error });
}

export function withErrorDetails(error, details) {
  const synodError = asSynodError(error);
  synodError.details = { ...synodError.details, ...details };
  return synodError;
}
