import { request } from './client';
export interface SkillRepository { repository: string; path?: string; ref?: string }
export interface SkillCandidate {
  id: string; name: string | null; displayName: string; description: string | null; stages: string[];
  source: { repository: string; commit: string; path: string; skillPath: string; digest: string; url: string };
  metadataStatus: string; compatibility: { status: string; declaration: string | null; runtimeVerified: false };
  license: { status: string; declaration: string | null; identifier: string; scope: string; document: { url: string; path: string; excerpt: string } | null };
  dependencies: { status: string; manifestPaths: string[]; totalManifests: number; inspectedManifests: number };
  capabilities: { status: string; allowedTools: string | null }; scripts: { total: number; paths: string[] };
  companionFiles: string[]; preview: { content: string; truncated: boolean }; issues: string[];
  installedMatch: { kind: string; identityVerified: false; name: string; source: string } | null;
  researchMatch: { explanation: string; matchedTerms: string[] };
}
export interface SkillDiscoveryResult {
  query: string; stage: string | null; candidates: SkillCandidate[]; status: 'complete' | 'partial';
  errors: { repository: string; path?: string; code: string; message: string }[];
  scope: { totalSkillFiles: number; offset: number; attempted: number; inspected: number; returned: number; nextOffset: number | null };
  sources: (SkillRepository & { commit: string; url: string })[];
}
export interface DiscoveryInput { repositories: SkillRepository[]; query: string; stage: string | null; offset: number; filters: { installed: 'any' | 'hide'; license: 'any' | 'document-found' } }
export const getSkillDiscoveryCatalogs = (id: string, signal?: AbortSignal) => request<{ catalogs: { id: string; label: string; repository: string; path: string; description: string }[] }>(`/api/projects/${encodeURIComponent(id)}/skill-discovery/catalogs`, { signal });
export const discoverSkills = (id: string, input: DiscoveryInput, signal?: AbortSignal) => request<SkillDiscoveryResult>(`/api/projects/${encodeURIComponent(id)}/skill-discovery`, { method: 'POST', body: JSON.stringify(input), signal });

export interface SkillInstallation {
  name: string; relativePath?: string; state: string; integrity: 'verified' | 'changed' | 'unknown';
  source: SelectedSkillSource | null; versionId?: string; bundleDigest?: string;
  installedAt?: string; fileCount?: number; totalBytes?: number; issues: string[];
  preservedLicenses?: { path: string; originalPath: string }[];
}
export interface SelectedSkillSource { repository: string; commit: string; path: string; digest: string }
export const selectedSkillSource = (candidate: SkillCandidate): SelectedSkillSource => ({ repository: candidate.source.repository, commit: candidate.source.commit, path: candidate.source.path, digest: candidate.source.digest });
export const getSkillInstallations = (id: string, signal?: AbortSignal) => request<{ installations: SkillInstallation[] }>(`/api/projects/${encodeURIComponent(id)}/skill-installations`, { signal });
export const installSkill = (id: string, candidate: SkillCandidate, signal?: AbortSignal) => request<{ installation: SkillInstallation; duplicate: boolean }>(`/api/projects/${encodeURIComponent(id)}/skill-installations`, {
  method: 'POST', signal, body: JSON.stringify({ selected: selectedSkillSource(candidate), confirmed: true })
});

export interface SkillVersion extends SkillInstallation { current: boolean; recordKind?: 'saved-source' }
export interface SkillUpdatePreview {
  name: string; current: SkillInstallation;
  selected: { source: SelectedSkillSource; versionId: string; bundleDigest: string };
  changes: { path: string; change: 'added' | 'removed' | 'changed'; beforeDigest: string | null; afterDigest: string | null; diff: string; diffTruncated: boolean }[];
  unchanged: boolean; requiresConfirmation: true; installationPerformed: false;
}
export interface SkillVersionDocument { name: string; versionId: string; source: SelectedSkillSource; file: string; sha256: string; content: string; bytes: number }
interface SkillLifecycleResult { installation: SkillInstallation | null; duplicate: boolean; uninstalled?: boolean; preservedVersionId?: string; bindingsChanged: false }
const installationUrl = (id: string, name: string) => `/api/projects/${encodeURIComponent(id)}/skill-installations/${encodeURIComponent(name)}`;
export const getSkillVersions = (id: string, name: string, signal?: AbortSignal) => request<{ name: string; versions: SkillVersion[] }>(`${installationUrl(id, name)}/versions`, { signal });
export const getSkillVersionDocument = (id: string, name: string, versionId: string, file = 'SKILL.md', signal?: AbortSignal) => request<SkillVersionDocument>(`${installationUrl(id, name)}/versions/${encodeURIComponent(versionId)}/document?${new URLSearchParams({ file })}`, { signal });
export const previewSkillUpdate = (id: string, name: string, selected: SelectedSkillSource, expectedVersionId: string, signal?: AbortSignal) => request<SkillUpdatePreview>(`${installationUrl(id, name)}/update-preview`, { method: 'POST', body: JSON.stringify({ selected, expectedVersionId }), signal });
export const updateSkill = (id: string, name: string, selected: SelectedSkillSource, expectedVersionId: string, signal?: AbortSignal) => request<SkillLifecycleResult>(`${installationUrl(id, name)}/update`, { method: 'POST', body: JSON.stringify({ selected, expectedVersionId, confirmed: true }), signal });
export const rollbackSkill = (id: string, name: string, versionId: string, expectedVersionId: string, signal?: AbortSignal) => request<SkillLifecycleResult>(`${installationUrl(id, name)}/rollback`, { method: 'POST', body: JSON.stringify({ versionId, expectedVersionId, confirmed: true }), signal });
export const uninstallSkill = (id: string, name: string, expectedVersionId: string, signal?: AbortSignal) => request<SkillLifecycleResult>(`${installationUrl(id, name)}/uninstall`, { method: 'POST', body: JSON.stringify({ expectedVersionId, confirmed: true }), signal });
