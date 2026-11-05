// Stored ZIP32 records follow PKWARE APPNOTE; UTF-8 names use general-purpose bit 11.
// https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
export const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 0xffff;
const MAX_NAME_BYTES = 240;
const encoder = new TextEncoder();

export function validateArchiveSize(sizes: number[]): void {
  if (!sizes.length || sizes.length > MAX_ENTRIES) throw new Error('Invalid archive file count.');
  let total = 0;
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid archive file size.');
    total += size;
    if (total > MAX_ARCHIVE_BYTES) throw new Error('Archive exceeds 256MiB.');
  }
}

function shorten(value: string, maxBytes: number): string {
  let length = 0;
  let result = '';
  for (const char of value) {
    length += encoder.encode(char).length;
    if (length > maxBytes) break;
    result += char;
  }
  return result;
}

function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  return dot > 0 && name.length - dot <= 20 ? [name.slice(0, dot), name.slice(dot)] : [name, ''];
}

function archiveName(input: string, used: Set<string>): string {
  const basename = input.normalize('NFC').split(/[/\\]/).at(-1) ?? '';
  let safe = Array.from(basename, char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? '_' : char).join('')
    .replace(/[<>:"|?*\u202a-\u202e\u2066-\u2069]/g, '_')
    .replace(/^\.+/, '').replace(/[. ]+$/, '').trim() || 'photo';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
  const [stem, extension] = splitExtension(safe);
  const ext = shorten(extension, 60);
  let suffix = '';
  let index = 1;
  let candidate: string;
  do {
    candidate = `${shorten(stem, MAX_NAME_BYTES - encoder.encode(ext + suffix).length)}${suffix}${ext}`;
    suffix = ` (${++index})`;
  } while (used.has(candidate.toLowerCase()));
  used.add(candidate.toLowerCase());
  return candidate;
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
  return value >>> 0;
});

async function checksum(blob: Blob): Promise<number> {
  const reader = blob.stream().getReader();
  let value = 0xffffffff;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      for (const byte of chunk.value) value = (value >>> 8) ^ crcTable[(value ^ byte) & 0xff]!;
    }
  } finally { reader.releaseLock(); }
  return (value ^ 0xffffffff) >>> 0;
}

function record(length: number): { bytes: Uint8Array<ArrayBuffer>; view: DataView } {
  const bytes = new Uint8Array(length);
  return { bytes, view: new DataView(bytes.buffer) };
}

export async function createPhotoArchive(entries: Array<{ name: string; blob: Blob }>): Promise<Blob> {
  // Check all declared sizes before opening a stream or allocating archive records.
  validateArchiveSize(entries.map(entry => entry.blob.size));
  const parts: BlobPart[] = [];
  const directory: BlobPart[] = [];
  const used = new Set<string>();
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    const name = encoder.encode(archiveName(entry.name, used));
    const crc = await checksum(entry.blob);
    const local = record(30 + name.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(12, 0x0021, true); // 1980-01-01; archive creation does not invent capture dates.
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, entry.blob.size, true);
    local.view.setUint32(22, entry.blob.size, true);
    local.view.setUint16(26, name.length, true);
    local.bytes.set(name, 30);
    parts.push(local.bytes, entry.blob);

    const central = record(46 + name.length);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(14, 0x0021, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, entry.blob.size, true);
    central.view.setUint32(24, entry.blob.size, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    central.bytes.set(name, 46);
    directory.push(central.bytes);
    directorySize += central.bytes.length;
    offset += local.bytes.length + entry.blob.size;
  }
  const end = record(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...parts, ...directory, end.bytes], { type: 'application/zip' });
}
