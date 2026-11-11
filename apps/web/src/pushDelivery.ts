import { ServerClient, deviceKeyFingerprint } from './server/client.ts';
import type { KeyStore } from './server/client.ts';
import { albumNotification } from './pushPayload.ts';
import type { AlbumNotification, IncomingPush } from './pushPayload.ts';

export interface PushDelivery {
  base: string;
  store: KeyStore;
  fetch: typeof fetch;
  show(message: AlbumNotification): Promise<void>;
  delay?: () => Promise<void>;
}

/** Every push proves the current persisted device again; background JWTs are never reused. */
export async function deliverPush(data: IncomingPush, deps: PushDelivery): Promise<void> {
  const keys = await deps.store.get();
  if (!keys) return;
  const fingerprint = await deviceKeyFingerprint(keys);
  const deadline = Date.now() + 15_000;
  const client = new ServerClient({
    base: deps.base,
    store: { get: async () => keys, put: async () => { throw new Error('Background identity creation is forbidden'); } },
    fetch: async (input, init) => {
      if (Date.now() >= deadline) throw new Error('Push processing unavailable');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.min(5000, deadline - Date.now()));
      try {
        const response = await deps.fetch(input, { ...init, signal: controller.signal });
        // Keep the timeout active while reading these small authenticated JSON responses.
        const body = await response.arrayBuffer();
        if (body.byteLength > 32_768) throw new Error('Push response too large');
        return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers });
      }
      finally { clearTimeout(timer); }
    },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (fingerprint !== await deviceKeyFingerprint(await deps.store.get())) return;
    try {
      const response = await client.op('phogaem-push-message', {
        version: 'v1', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: data.id }),
      });
      // Approval revocation, removal, disabled notifications and another recipient fail closed.
      if ([401, 403, 404, 410].includes(response.status)) return;
      if (!response.ok) throw new Error('Push message unavailable');
      if (client.userId !== data.recipientId) return;
      const message = albumNotification(await response.json(), data);
      if (!message || fingerprint !== await deviceKeyFingerprint(await deps.store.get())) return;
      await deps.show(message);
      return;
    } catch {
      if (attempt === 1 || Date.now() >= deadline) throw new Error('Push processing unavailable');
      await (deps.delay?.() ?? new Promise(resolve => setTimeout(resolve, 500)));
    }
  }
}
