export class HarnessRuntimeError extends Error {
  constructor(statusCode, code, message, details, { retryable = false } = {}) {
    super(message);
    this.name = 'HarnessRuntimeError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.retryable = retryable;
  }
}

export function asRuntimeError(error, fallbackCode = 'HARNESS_RUNTIME_ERROR') {
  if (error instanceof HarnessRuntimeError) return error;
  return new HarnessRuntimeError(
    500,
    fallbackCode,
    error instanceof Error ? error.message : String(error),
    undefined,
    { retryable: true }
  );
}
