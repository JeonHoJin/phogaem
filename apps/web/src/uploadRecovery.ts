import { fileMediaType, hashBlob } from './domain.ts';

export interface RecoveryScope { userId: string; albumId: string }
export interface RecoveryFingerprint { hash: string; size: number; type: string }
export interface UploadRecovery {
  version: 1;
  plannedCount: number;
  completed: Array<RecoveryFingerprint & { count: number }>;
}
const MAX_FILES = 20_000;
const HASH = /^[a-f0-9]{64}$/;
const TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'image/heic', 'image/heif', 'video/mp4', 'video/quicktime', 'video/webm']);
function fingerprintKey(value: RecoveryFingerprint): string { return `${value.hash}:${value.size}:${value.type}`; }
function validFingerprint(value: unknown): value is RecoveryFingerprint {
  if (!value || typeof value !== 'object') return false;
  const item = value as RecoveryFingerprint;
  return typeof item.hash === 'string' && HASH.test(item.hash) && Number.isSafeInteger(item.size) && item.size > 0 && TYPES.has(item.type);
}
function validRecovery(value: unknown): value is UploadRecovery {
  if (!value || typeof value !== 'object') return false;
  const item = value as UploadRecovery;
  if (item.version !== 1 || !Number.isSafeInteger(item.plannedCount) || item.plannedCount < 1 || item.plannedCount > MAX_FILES || !Array.isArray(item.completed) || item.completed.length > item.plannedCount) return false;
  let count = 0;
  const keys = new Set<string>();
  for (const entry of item.completed) {
    if (!validFingerprint(entry) || !Number.isSafeInteger(entry.count) || entry.count < 1) return false;
    const key = fingerprintKey(entry);
    if (keys.has(key)) return false;
    keys.add(key); count += entry.count;
    if (count > item.plannedCount) return false;
  }
  return true;
}
function minimalManifest(manifest: UploadRecovery): UploadRecovery {
  return { version: 1, plannedCount: manifest.plannedCount, completed: manifest.completed.map(({ hash, size, type, count }) => ({ hash, size, type, count })) };
}
function storageKey(scope: RecoveryScope): string {
  if (!scope.userId || !scope.albumId || scope.userId.length > 128 || scope.albumId.length > 128) throw new Error('Invalid recovery scope.');
  const path = import.meta.env?.BASE_URL ?? (typeof location === 'undefined' ? '/' : new URL('.', location.href).pathname);
  return `phogaem:${path}:upload-recovery:${encodeURIComponent(scope.userId)}:${encodeURIComponent(scope.albumId)}`;
}

export function createUploadRecovery(plannedCount: number): UploadRecovery {
  const manifest: UploadRecovery = { version: 1, plannedCount, completed: [] };
  if (!validRecovery(manifest)) throw new Error('Invalid recovery file count.');
  return manifest;
}

/** Call only after the server acknowledges this occurrence, never on request start. */
export function addRecoveryCompletion(manifest: UploadRecovery, fingerprint: RecoveryFingerprint): UploadRecovery {
  if (!validRecovery(manifest) || !validFingerprint(fingerprint)) throw new Error('Invalid recovery completion.');
  const key = fingerprintKey(fingerprint);
  const completed = manifest.completed.map(entry => ({ ...entry }));
  const existing = completed.find(entry => fingerprintKey(entry) === key);
  if (existing) existing.count += 1;
  else completed.push({ hash: fingerprint.hash, size: fingerprint.size, type: fingerprint.type, count: 1 });
  const next: UploadRecovery = { version: 1, plannedCount: manifest.plannedCount, completed };
  if (!validRecovery(next)) throw new Error('Recovery completion exceeds planned count.');
  return next;
}

export function loadUploadRecovery(scope: RecoveryScope): UploadRecovery | null {
  try {
    const raw = localStorage.getItem(storageKey(scope));
    if (!raw || raw.length > 3_000_000) return null;
    const value: unknown = JSON.parse(raw);
    return validRecovery(value) ? minimalManifest(value) : null;
  } catch { return null; }
}

/** Optional persistence must not turn an acknowledged upload into a failed upload. */
export function saveUploadRecovery(scope: RecoveryScope, manifest: UploadRecovery): boolean {
  try {
    if (!validRecovery(manifest)) return false;
    localStorage.setItem(storageKey(scope), JSON.stringify(minimalManifest(manifest)));
    return true;
  } catch { return false; }
}
export function clearUploadRecovery(scope: RecoveryScope): boolean {
  try { localStorage.removeItem(storageKey(scope)); return true; }
  catch { return false; }
}

/** One on-demand hash at a time in the caller; each acknowledged occurrence is consumed once. */
export function createRecoveryMatcher(manifest: UploadRecovery): { consume: (file: File) => Promise<boolean> } {
  if (!validRecovery(manifest)) throw new Error('Invalid upload recovery.');
  const remaining = new Map(manifest.completed.map(entry => [fingerprintKey(entry), entry.count]));
  const possible = new Set(manifest.completed.map(entry => `${entry.size}:${entry.type}`));
  return { async consume(file) {
    const type = fileMediaType(file);
    if (!type || !possible.has(`${file.size}:${type}`)) return false;
    const key = fingerprintKey({ hash: await hashBlob(file), size: file.size, type });
    const count = remaining.get(key) ?? 0;
    if (!count) return false;
    remaining.set(key, count - 1);
    return true;
  } };
}
