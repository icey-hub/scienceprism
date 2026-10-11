export function pageErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message;
  return typeof error === 'string' ? error : '';
}

export function isPageResourceError(error: unknown): boolean {
  return /Failed to fetch dynamically imported module|Importing a module script failed|Loading chunk .+ failed|Unable to preload CSS/i.test(pageErrorMessage(error))
    || !!(error && typeof error === 'object' && 'name' in error && error.name === 'ChunkLoadError');
}
