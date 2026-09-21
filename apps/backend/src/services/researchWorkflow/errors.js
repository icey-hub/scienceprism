export class ResearchWorkflowError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.name = 'ResearchWorkflowError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function assertProjectId(projectId) {
  if (typeof projectId !== 'string' || !projectId || !/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new ResearchWorkflowError(400, 'INVALID_PROJECT_ID', 'Invalid project id.');
  }
}

export function sanitizeActor(actor) {
  if (actor === undefined || actor === null || actor === '') return 'human';
  const value = String(actor).trim();
  return value && value.length <= 120 ? value : 'human';
}

export function sanitizeNote(note) {
  if (note === undefined || note === null) return undefined;
  const value = String(note).trim();
  if (value.length > 2000) {
    throw new ResearchWorkflowError(400, 'INVALID_NOTE', 'note must be at most 2000 characters.');
  }
  return value || undefined;
}

export function assertPlainObject(value, field = 'data') {
  if (value === undefined) return {};
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ResearchWorkflowError(400, 'INVALID_DATA', `${field} must be an object.`);
  }
  return value;
}

export function assertExpectedVersion(expectedVersion) {
  if (expectedVersion === undefined || expectedVersion === null || expectedVersion === '') return undefined;
  const value = Number(expectedVersion);
  if (!Number.isInteger(value) || value < 1) {
    throw new ResearchWorkflowError(400, 'INVALID_VERSION', 'expectedVersion must be a positive integer.');
  }
  return value;
}

