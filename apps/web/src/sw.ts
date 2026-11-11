/// <reference lib="webworker" />
import { API_BASE, indexedDbKeyStore } from './server/index.ts';
import { incomingPush, notificationTarget } from './pushPayload.ts';
import { deliverPush } from './pushDelivery.ts';
import type { IncomingPush } from './pushPayload.ts';

const worker = self as unknown as ServiceWorkerGlobalScope;
const basePath = import.meta.env.BASE_URL;
const pending = new Map<string, Promise<void>>();

async function deliver(data: IncomingPush): Promise<void> {
  await deliverPush(data, {
    base: API_BASE, store: indexedDbKeyStore, fetch: globalThis.fetch.bind(globalThis),
    show: message => worker.registration.showNotification(message.title, {
      body: message.body,
      icon: new URL(`${basePath}icons/icon-192.png`, worker.location.origin).href,
      tag: `phogaem:${message.albumId}`,
      data: { id: data.id, albumId: data.albumId },
    }),
  });
}

worker.addEventListener('install', event => event.waitUntil(worker.skipWaiting()));
worker.addEventListener('activate', event => event.waitUntil(worker.clients.claim()));
worker.addEventListener('push', event => {
  let data: IncomingPush | null = null;
  try { data = incomingPush(event.data?.json()); } catch { /* malformed push has no authority */ }
  const notification = data;
  // Safari requires visible content for EVERY push, even during network/storage failure.
  // The fallback has no album name, nickname, count, photo or account information.
  event.waitUntil(worker.registration.showNotification('포갬', {
    body: '새 사진', tag: notification ? `phogaem:${notification.albumId}` : 'phogaem',
    icon: new URL(`${basePath}icons/icon-192.png`, worker.location.origin).href,
    data: notification ? { id: notification.id, albumId: notification.albumId } : {},
  }).then(() => {
    if (!notification) return;
    let action = pending.get(notification.id);
    if (!action) {
      action = deliver(notification).catch(() => {
        console.warn('Phogaem notification details unavailable');
      }).finally(() => pending.delete(notification.id));
      pending.set(notification.id, action);
    }
    return action;
  }));
});
worker.addEventListener('notificationclick', event => {
  event.notification.close();
  const albumId: unknown = event.notification.data?.albumId;
  if (typeof albumId !== 'string') return;
  let target: string;
  try { target = notificationTarget(albumId, worker.location.origin, basePath); } catch { return; }
  event.waitUntil((async () => {
    const clients = await worker.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = clients.find(client => {
      const url = new URL(client.url);
      return url.origin === worker.location.origin && url.pathname.startsWith(basePath);
    });
    if (existing) { await existing.navigate(target); await existing.focus(); }
    else await worker.clients.openWindow(target);
  })());
});
