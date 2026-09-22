export const SETTINGS_STORAGE_KEY = 'scienceprism-settings-v1';
export const LEGACY_SETTINGS_STORAGE_KEYS = Object.freeze(['openprism-settings-v1']);
export const COLLAB_STORAGE_KEY = 'scienceprism-collab-name';
export const LEGACY_COLLAB_STORAGE_KEYS = Object.freeze(['openprism-collab-name']);

export function readFirstStoredValue(storage, keys) {
  for (const key of keys) {
    const value = storage?.getItem(key);
    if (value) return { key, value };
  }
  return { key: null, value: null };
}

export function migrateSettingsRecord(storage, defaults) {
  const found = readFirstStoredValue(storage, [SETTINGS_STORAGE_KEY, ...LEGACY_SETTINGS_STORAGE_KEYS]);
  if (!found.value) return { settings: { ...defaults }, migrated: false };
  try {
    const parsed = JSON.parse(found.value);
    const settings = { ...defaults, ...(parsed && typeof parsed === 'object' ? parsed : {}) };
    if (found.key !== SETTINGS_STORAGE_KEY) storage?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    return { settings, migrated: found.key !== SETTINGS_STORAGE_KEY };
  } catch {
    return { settings: { ...defaults }, migrated: false };
  }
}

export function migrateCollabName(storage) {
  const found = readFirstStoredValue(storage, [COLLAB_STORAGE_KEY, ...LEGACY_COLLAB_STORAGE_KEYS]);
  if (found.value && found.key !== COLLAB_STORAGE_KEY) storage?.setItem(COLLAB_STORAGE_KEY, found.value);
  return found.value || '';
}
