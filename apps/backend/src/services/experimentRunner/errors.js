export class ExperimentRunnerError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ExperimentRunnerError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
