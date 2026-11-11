const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export interface IncomingPush { id: string; albumId: string; recipientId: string }
export interface AlbumNotification { id: string; albumId: string; title: string; body: string }

export function incomingPush(value: unknown): IncomingPush | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (![data.id, data.albumId, data.recipientId].every(item => typeof item === 'string' && uuid.test(item))) return null;
  return { id: data.id as string, albumId: data.albumId as string, recipientId: data.recipientId as string };
}

export function albumNotification(value: unknown, expected: IncomingPush): AlbumNotification | null {
  if (!value || typeof value !== 'object') return null;
  const data = value as Record<string, unknown>;
  if (data.id !== expected.id || data.albumId !== expected.albumId
    || typeof data.title !== 'string' || !data.title || data.title.length > 200
    || typeof data.body !== 'string' || !data.body || data.body.length > 500
    || [...(data.title + data.body)].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return null;
  return { id: expected.id, albumId: expected.albumId, title: data.title, body: data.body };
}

export function notificationTarget(albumId: string, origin: string, basePath: string): string {
  if (!uuid.test(albumId)) throw new Error('보관함 주소 오류');
  const url = new URL(basePath, origin);
  if (url.origin !== origin || !url.pathname.endsWith('/')) throw new Error('보관함 주소 오류');
  url.hash = new URLSearchParams({ album: albumId }).toString();
  return url.href;
}

export function notificationAlbum(hash: string): string | null {
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const album = params.get('album');
  return !params.has('invite') && params.getAll('album').length === 1 && album && uuid.test(album) ? album : null;
}
