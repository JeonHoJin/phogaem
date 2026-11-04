export type MemberId = string;

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
}

export type PhotoFilter = 'all' | 'others' | 'mine' | 'duplicates' | 'unreceived';

export const MEMBERS: { id: MemberId; name: string; color: string }[] = [
  { id: 'me', name: '나', color: '#e1c1a8' },
  { id: 'mina', name: '미나', color: '#c5d6c4' },
  { id: 'jun', name: '준', color: '#c9d3df' },
  { id: 'sora', name: '소라', color: '#e5d6b6' },
];

export function filterPhotos(photos: Photo[], filter: PhotoFilter, member: MemberId): Photo[] {
  return photos.filter((photo) => matchesFilters(photo, [filter], member));
}

export function matchesFilters(photo: Photo, filters: PhotoFilter[], member: MemberId): boolean {
  return filters.every((filter) => {
    switch (filter) {
      case 'all': return true;
      case 'others': return !photo.contributors.includes(member);
      case 'mine': return photo.contributors.includes(member);
      case 'duplicates': return (photo.importCount ?? photo.contributors.length) > 1;
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
