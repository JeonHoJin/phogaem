/** Memory-only thumbnail blobs. Originals and object URLs are owned by their callers. */
export class ThumbnailCache {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly blobs = new Map<string, Blob>();
  private readonly pending = new Map<string, Promise<Blob>>();
  private bytes = 0;
  private generation = 0;

  constructor(options: { maxEntries?: number; maxBytes?: number } = {}) {
    this.maxEntries = options.maxEntries ?? 128;
    this.maxBytes = options.maxBytes ?? 24 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 0 || !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) {
      throw new RangeError('Invalid thumbnail cache limits');
    }
  }

  get(key: string, load: () => Promise<Blob>): Promise<Blob> {
    const cached = this.blobs.get(key);
    if (cached) {
      this.blobs.delete(key);
      this.blobs.set(key, cached);
      return Promise.resolve(cached);
    }
    const existing = this.pending.get(key);
    if (existing) return existing;

    const generation = this.generation;
    const request = Promise.resolve().then(load).then(blob => {
      if (generation === this.generation && this.maxEntries > 0 && blob.size <= this.maxBytes) {
        this.blobs.set(key, blob);
        this.bytes += blob.size;
        while (this.blobs.size > this.maxEntries || this.bytes > this.maxBytes) {
          const oldest = this.blobs.keys().next().value!;
          this.bytes -= this.blobs.get(oldest)!.size;
          this.blobs.delete(oldest);
        }
      }
      return blob;
    }).finally(() => {
      // A clear may have replaced this key with a request from a new account/album.
      if (this.pending.get(key) === request) this.pending.delete(key);
    });
    this.pending.set(key, request);
    return request;
  }

  clear(): void {
    this.generation += 1;
    this.blobs.clear();
    this.pending.clear();
    this.bytes = 0;
  }
}
