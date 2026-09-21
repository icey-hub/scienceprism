export class EvidenceLedgerError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'EvidenceLedgerError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}
