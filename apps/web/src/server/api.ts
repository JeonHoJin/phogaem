import { server, ServerError } from './index.ts';
import type { PhotoProcessing, ProcessingKind } from '../domain.ts';

export interface Album { id: string; title: string; createdAt: number; ownerId?: string }
export interface SharedMember { id: string; name: string; color: string; nickname?: string | null }
export interface RemotePhoto {
  id: string;
  name: string;
  type: string;
  size: number;
  hash: string;
  createdAt: number;
  contributors: string[];
  requestedBy: string[];
  receivedBy: string[];
  importCount: number;
  processing?: PhotoProcessing;
}
export interface SharedAlbum { album: Album; members: SharedMember[]; photos: RemotePhoto[] }
export interface SimilarGroup { id: string; photoIds: string[]; representativeId?: string }
export interface SimilarPhotos { groups: SimilarGroup[]; pending: number; failed: number; analyzed: number }


export const SHARED_MAX_FILE_SIZE = 16 * 1024 * 1024;

/** Account approval is enforced by the core before the sidecar is called. */
export class ApprovalRequired extends ServerError {
  readonly accountCode: string;
  constructor(userId?: string) {
    super(403, '관리자 승인이 필요한 계정이에요. 기존에 승인받은 계정이라면 패스키로 연결해 주세요.');
    this.name = 'ApprovalRequired';
    this.accountCode = userId?.replace(/-/g, '').slice(0, 8) ?? '';
  }
}

async function checked(response: Response): Promise<Response> {
  if (response.ok) return response;
  const data = await response.json().catch(() => ({})) as { error?: string };
  if (response.status === 403 && data.error === 'approval required') {
    throw new ApprovalRequired(server.userId);
  }
  const messages: Record<number, string> = {
    401: '로그인 확인이 필요해요. 다시 연결해 주세요.',
    403: '이 작업을 할 권한이 없어요.',
    404: '보관함이나 사진을 찾을 수 없어요. 서버 기능이 준비되었는지도 확인해 주세요.',
    410: '초대가 만료됐어요. 새 초대를 받아 주세요.',
    413: '공유 사진은 파일당 최대 16MB까지 올릴 수 있어요.',
    429: '요청이 잠시 몰렸어요. 잠시 후 다시 시도해 주세요.',
    503: '공유 서버가 아직 준비되지 않았어요. 잠시 후 다시 연결해 주세요.',
  };
  const context = messages[response.status] ?? '서버 작업을 완료하지 못했어요.';
  throw new ServerError(response.status, `${context}${data.error ? ` (${data.error})` : ''}`);
}

async function json<T>(name: string, body?: unknown, query?: Record<string, string>, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
  const response = await server.op(`phogaem-${name}`, {
    version: 'v1', method, query,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
  });
  return (await checked(response)).json() as Promise<T>;
}

export function listAlbums(): Promise<{ userId: string; albums: Album[] }> {
  return json('albums');
}

export async function createAlbum(title: string, nickname?: string): Promise<Album> {
  return (await json<{ album: Album }>('album-create', { title, ...(nickname !== undefined ? { nickname } : {}) })).album;
}

export function getAlbum(albumId: string): Promise<SharedAlbum> {
  return json('album-get', undefined, { albumId });
}

export async function getSimilarPhotos(albumId: string): Promise<SimilarPhotos> {
  const value: unknown = await json('similar-get', undefined, { albumId });
  const invalid = () => { throw new ServerError(502, '비교 후보 응답을 확인하지 못했어요.'); };
  if (!value || typeof value !== 'object') return invalid();
  const data = value as Record<string, unknown>;
  if (!Array.isArray(data.groups) || data.groups.length > 1000) return invalid();
  for (const key of ['pending', 'failed', 'analyzed']) {
    if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 2000) return invalid();
  }
  if ((data.pending as number) + (data.failed as number) + (data.analyzed as number) > 2000) return invalid();
  const seenIds = new Set<string>();
  const seenPhotos = new Set<string>();
  const identifier = (x: unknown): x is string => typeof x === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(x);
  const groups: SimilarGroup[] = [];
  for (const entry of data.groups) {
    if (!entry || typeof entry !== 'object') return invalid();
    const group = entry as Record<string, unknown>;
    if (!identifier(group.id) || seenIds.has(group.id) || !Array.isArray(group.photoIds) || group.photoIds.length < 2 || group.photoIds.length > 12) return invalid();
    seenIds.add(group.id);
    const photoIds: string[] = [];
    for (const id of group.photoIds) {
      if (!identifier(id) || seenPhotos.has(id)) return invalid();
      seenPhotos.add(id); if (seenPhotos.size > 2000) return invalid(); photoIds.push(id);
    }
    if (group.representativeId !== undefined && (!identifier(group.representativeId) || !photoIds.includes(group.representativeId))) return invalid();
    groups.push({ id: group.id, photoIds, ...(group.representativeId !== undefined ? { representativeId: group.representativeId as string } : {}) });
  }
  return { groups, pending: data.pending as number, failed: data.failed as number, analyzed: data.analyzed as number };
}


export function createInvite(albumId: string): Promise<{ token: string; expiresAt: number }> {
  return json('invite-create', { albumId });
}

export async function joinInvite(token: string, nickname?: string): Promise<Album> {
  return (await json<{ album: Album }>('invite-join', { token, ...(nickname !== undefined ? { nickname } : {}) })).album;
}

function fileType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split('.').at(-1)?.toLowerCase();
  return ({ jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', heic: 'image/heic', heif: 'image/heif' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}

export function validateSharedFiles(files: File[]): void {
  for (const file of files) {
    if (!file.size) throw new Error(`${file.name}: 비어 있는 파일이에요.`);
    if (file.size > SHARED_MAX_FILE_SIZE) throw new Error(`${file.name}: 공유 사진은 파일당 최대 16MB까지 올릴 수 있어요.`);
    if (/svg/i.test(file.type) || /\.svgz?$/i.test(file.name)) throw new Error(`${file.name}: SVG 파일은 올릴 수 없어요.`);
    if ([...file.name].length > 200 || [...file.name].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 || char === '/' || char === '\\')) throw new Error('사진 파일 이름에 사용할 수 없는 문자가 있어요.');
    if (!/^image\/(jpeg|png|webp|gif|avif|heic|heif|heic-sequence|heif-sequence)$/i.test(fileType(file)) && !/\.(jpe?g|png|webp|gif|avif|heic|heif)$/i.test(file.name)) {
      throw new Error(`${file.name}: 지원하는 사진 파일을 선택해 주세요.`);
    }
  }
}

export interface UploadProgress {
  photo: RemotePhoto;
  index: number;
  completedIndices: number[];
}

const uploadFailureIndices = new WeakMap<object, number>();
export function getUploadFailureIndex(error: unknown): number | undefined {
  return error !== null && typeof error === 'object' ? uploadFailureIndices.get(error) : undefined;
}

interface UploadTask { run: () => Promise<void>; cancelled: () => boolean; resolve: () => void; reject: (error: unknown) => void }
// Originals and uploads share a transfer start budget, reserving gateway headroom for metadata.
let nextTransferStart = 0;
const uploadQueue: UploadTask[] = [];
let activeUploads = 0;
let nextUploadStart = 0;
let uploadTimer: ReturnType<typeof setTimeout> | undefined;

function pumpUploads(): void {
  if (uploadTimer !== undefined) return;
  while (uploadQueue[0]?.cancelled()) uploadQueue.shift()!.resolve();
  if (activeUploads >= 2 || !uploadQueue.length) return;
  const wait = Math.max(0, Math.max(nextUploadStart, nextTransferStart) - Date.now());
  if (wait) {
    uploadTimer = setTimeout(() => { uploadTimer = undefined; pumpUploads(); }, wait);
    return;
  }
  const task = uploadQueue.shift()!;
  activeUploads += 1;
  nextUploadStart = Date.now() + 350;
  nextTransferStart = Date.now() + 250;
  task.run().then(task.resolve, task.reject).finally(() => { activeUploads -= 1; pumpUploads(); });
  pumpUploads();
}

function queuedUpload(run: () => Promise<void>, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => { uploadQueue.push({ run, cancelled, resolve, reject }); pumpUploads(); });
}

export async function uploadSharedPhotos(albumId: string, files: File[], onProgress?: (completed: number, event: UploadProgress) => void, onFailure?: (error: unknown, index: number) => void): Promise<{ added: number; duplicates: number }> {
  // Reject an invalid batch before scheduling any writes. Each successful file is committed
  // independently; out-of-order completions report their actual indices, never a prefix.
  validateSharedFiles(files);
  let added = 0;
  let duplicates = 0;
  const completedIndices = new Set<number>();
  const failures: Array<{ error: unknown; index: number }> = [];
  await Promise.allSettled(files.map((file, index) => queuedUpload(async () => {
    try {
      const response = await server.op('phogaem-photo-upload', {
        version: 'v1', method: 'POST', query: { albumId, name: file.name },
        headers: { 'content-type': fileType(file) }, body: file,
      });
      const result = await (await checked(response)).json() as { added: boolean; photo: RemotePhoto };
      if (result.added) added += 1;
      else duplicates += 1;
      completedIndices.add(index);
      onProgress?.(added + duplicates, { photo: result.photo, index, completedIndices: [...completedIndices].sort((a, b) => a - b) });
    } catch (error) {
      // Mark the batch before releasing its queue slot so no new file starts after denial.
      failures.push({ error, index });
      // Notify denial immediately while already-started writes still drain. Observer failures
      // must never replace the server error or reopen the stopped queue.
      try { onFailure?.(error, index); } catch { /* observation must not affect upload state */ }
      throw error;
    }
  }, () => failures.length > 0)));
  // In-flight writes may already have committed. Drain all of them before returning or
  // throwing so callers can safely retain only uncommitted files and clear revoked access.
  const failure = failures.find(item => item.error instanceof ApprovalRequired) ?? failures[0];
  if (failure) {
    let error = failure.error;
    if (added + duplicates) {
      const message = error instanceof Error ? error.message : '업로드를 완료하지 못했어요.';
      const partial = `${added}장 추가 · 중복 ${duplicates}장 처리 후 중단됐어요. 새로고침해 결과를 확인해 주세요. ${message}`;
      if (error instanceof ServerError) error.message = partial;
      else error = new Error(partial, { cause: error });
    }
    if (error !== null && typeof error === 'object') uploadFailureIndices.set(error, failure.index);
    throw error;
  }
  return { added, duplicates };
}

interface OriginalResult { response: Response; blob?: Blob }
const originalQueue: Array<{ run: () => Promise<OriginalResult>; priority: () => number; resolve: (value: OriginalResult) => void; reject: (reason: unknown) => void }> = [];
let activeOriginals = 0;
let nextOriginalStart = 0;
let originalTimer: ReturnType<typeof setTimeout> | undefined;

function pumpOriginalQueue(): void {
  if (originalTimer !== undefined || activeOriginals >= 2 || !originalQueue.length) return;
  const wait = Math.max(0, Math.max(nextOriginalStart, nextTransferStart) - Date.now());
  if (wait) {
    originalTimer = setTimeout(() => { originalTimer = undefined; pumpOriginalQueue(); }, wait);
    return;
  }
  // Read scores when a slot opens: scrolling may have made a queued preview visible.
  const score = (priority: () => number) => {
    try { const value = priority(); return Number.isFinite(value) ? value : Infinity; }
    catch { return Infinity; }
  };
  let next = 0;
  let best = score(originalQueue[0]!.priority);
  for (let index = 1; index < originalQueue.length; index += 1) {
    const value = score(originalQueue[index]!.priority);
    if (value < best) { next = index; best = value; }
  }
  const [task] = originalQueue.splice(next, 1);
  activeOriginals += 1;
  nextOriginalStart = Date.now() + 350;
  nextTransferStart = Date.now() + 250;
  task.run().then(task.resolve, task.reject).finally(() => { activeOriginals -= 1; pumpOriginalQueue(); });
  pumpOriginalQueue();
}

function queuedOriginal(run: () => Promise<OriginalResult>, priority: () => number): Promise<OriginalResult> {
  return new Promise((resolve, reject) => { originalQueue.push({ run, priority, resolve, reject }); pumpOriginalQueue(); });
}

function retryDelay(response: Response): number {
  const value = response.headers.get('retry-after');
  const seconds = value === null ? Number.NaN : Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : value ? Date.parse(value) - Date.now() : 1000;
  return Math.min(3000, Math.max(350, Number.isFinite(delay) ? delay : 1000));
}

async function getImageBlob(operation: 'photo-get' | 'thumbnail-get', albumId: string, photoId: string, priority?: () => number): Promise<Blob> {
  // The gateway allows 5 requests/sec per IP. Pace originals and keep at most two in flight;
  // metadata and mutations stay outside this queue. Only this idempotent GET retries a 429.
  for (let attempt = 0; ; attempt += 1) {
    const { response, blob } = await queuedOriginal(async () => {
      const response = await server.op(`phogaem-${operation}`, { version: 'v1', method: 'GET', query: { albumId, photoId } });
      return { response, blob: response.ok ? await response.blob() : undefined };
    }, operation === 'photo-get' ? () => -1 : () => Math.max(0, priority?.() ?? 0));
    if (response.status === 429 && attempt === 0) {
      await new Promise(resolve => setTimeout(resolve, retryDelay(response)));
      continue;
    }
    await checked(response);
    return blob!;
  }
}

export function getPhotoBlob(albumId: string, photoId: string): Promise<Blob> {
  return getImageBlob('photo-get', albumId, photoId);
}

export function getThumbnailBlob(albumId: string, photoId: string, priority?: () => number): Promise<Blob> {
  return getImageBlob('thumbnail-get', albumId, photoId, priority);
}

export async function retryProcessing(albumId: string, photoId: string, kind: ProcessingKind): Promise<void> {
  await json('processing-retry', { albumId, photoId, kind });
}

export async function setSharedDownloadState(albumId: string, photoIds: string[], state: 'requested' | 'received' | 'reset'): Promise<void> {
  await json('download-state', { albumId, photoIds, state });
}


export function setRepresentative(albumId: string, groupId: string, photoId: string): Promise<{ ok: boolean }> {
  return json('representative-set', { albumId, groupId, photoId });
}

export function setMemberNickname(albumId: string, nickname: string, userId?: string): Promise<{ ok: boolean }> {
  return json('member-name-set', { albumId, nickname, ...(userId ? { userId } : {}) });
}
