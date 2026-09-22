export const SETTINGS_STORAGE_KEY: string;
export const LEGACY_SETTINGS_STORAGE_KEYS: readonly string[];
export const COLLAB_STORAGE_KEY: string;
export const LEGACY_COLLAB_STORAGE_KEYS: readonly string[];

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function readFirstStoredValue(storage: StorageLike | null | undefined, keys: readonly string[]): { key: string | null; value: string | null };
export function migrateSettingsRecord<T extends object>(storage: StorageLike | null | undefined, defaults: T): { settings: T & Record<string, unknown>; migrated: boolean };
export function migrateCollabName(storage: StorageLike | null | undefined): string;
