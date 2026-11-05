export type MemberId = string;

export type ProcessingKind = 'thumbnail' | 'vision';
export type ProcessingState = 'pending' | 'running' | 'succeeded' | 'failed';
export interface ProcessingJob { state: ProcessingState; attempts: number }
export type PhotoProcessing = Record<ProcessingKind, ProcessingJob>;

export interface Photo {
  id: string;
  name: string;
  type: string;
  size: number;
  hash: string;
  createdAt: number;
  contributors: MemberId[];
  requestedBy: MemberId[];
  receivedBy: MemberId[];
  blob?: Blob;
  albumId?: string;
  importCount?: number;
  processing?: PhotoProcessing;
}

export type PhotoFilter = 'all' | 'others' | 'mine' | 'duplicates' | 'unreceived';

export const MEMBERS: { id: MemberId; name: string; color: string }[] = [
  { id: 'me', name: '나', color: '#e1c1a8' },
  { id: 'mina', name: '미나', color: '#c5d6c4' },
  { id: 'jun', name: '준', color: '#c9d3df' },
  { id: 'sora', name: '소라', color: '#e5d6b6' },
];

export function filterPhotos(photos: Photo[], filter: PhotoFilter, member: MemberId, similarIds?: ReadonlySet<string>): Photo[] {
  return photos.filter((photo) => matchesFilters(photo, [filter], member, similarIds));
}

export function matchesFilters(photo: Photo, filters: PhotoFilter[], member: MemberId, similarIds?: ReadonlySet<string>): boolean {
  return filters.every((filter) => {
    switch (filter) {
      case 'all': return true;
      case 'others': return !photo.contributors.includes(member);
      case 'mine': return photo.contributors.includes(member);
      case 'duplicates': return (photo.importCount ?? photo.contributors.length) > 1 || similarIds?.has(photo.id) === true;
      case 'unreceived': return !photo.receivedBy.includes(member);
      default: return false;
    }
  });
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

export async function hashBlob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function defaultAlbumName(date = new Date()): string {
  const year = String(date.getFullYear()).slice(-2).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}${month}${day} 여행`;
}

export function mergeUploadedPhoto(photos: Photo[], incoming: Photo): Photo[] {
  const previous = photos.find(photo => photo.id === incoming.id);
  const updated = previous ? {
    ...previous, ...incoming,
    contributors: [...new Set([...previous.contributors, ...incoming.contributors])],
    importCount: Math.max(previous.importCount ?? previous.contributors.length, incoming.importCount ?? incoming.contributors.length),
  } : incoming;
  return [updated, ...photos.filter(photo => photo.id !== incoming.id)].sort((a, b) => b.createdAt - a.createdAt);
}
