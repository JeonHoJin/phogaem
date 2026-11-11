import { useEffect, useRef, useState } from 'react';
import { currentPushSubscription, enableAlbumPush, getAlbumPushStatus, pushSupported, unsubscribeAlbumPush } from './server/push';

export function AlbumNotifications({ albumId, userId, onError, active = true }: {
  albumId: string; userId: string; onError: (error: unknown) => void; active?: boolean;
}) {
  const [supported] = useState(pushSupported);
  const [enabled, setEnabled] = useState(false);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [pending, setPending] = useState(true);
  const current = useRef(0);
  const isActive = useRef(active);
  // A parent transition can leave the old album mounted while its replacement loads.
  // Invalidate before passive effect cleanup, so an open permission dialog cannot win it.
  if (isActive.current !== active) {
    if (!active) current.current += 1;
    isActive.current = active;
  }
  const report = useRef(onError);
  useEffect(() => { report.current = onError; }, [onError]);

  useEffect(() => {
    const epoch = ++current.current;
    let mounted = true;
    if (!supported || !active) return;
    setPending(true); setEnabled(false); setPublicKey(null); setEndpoint(null);
    void (async () => {
      try {
        const subscription = await currentPushSubscription();
        if (!mounted || !isActive.current || current.current !== epoch) return;
        const status = await getAlbumPushStatus(albumId, subscription?.endpoint);
        if (!mounted || !isActive.current || current.current !== epoch) return;
        setEnabled(status.enabled); setPublicKey(status.publicKey); setEndpoint(subscription?.endpoint ?? null);
      } catch (error) { if (mounted && isActive.current && current.current === epoch) report.current(error); }
      finally { if (mounted && isActive.current && current.current === epoch) setPending(false); }
    })();
    return () => { mounted = false; current.current += 1; };
  }, [albumId, userId, supported, active]);

  function toggle() {
    if (pending || !isActive.current) return;
    const epoch = current.current;
    const isCurrent = () => isActive.current && current.current === epoch;
    setPending(true);
    let operation: Promise<unknown>;
    try {
      // Do not put an await before enableAlbumPush: iOS requires this click's activation.
      operation = enabled && endpoint ? unsubscribeAlbumPush(albumId, endpoint)
        : publicKey ? enableAlbumPush(albumId, publicKey, isCurrent) : Promise.reject(new Error('알림을 사용할 수 없어요.'));
    } catch (error) { operation = Promise.reject(error); }
    void operation.then(result => {
      if (!isCurrent()) return;
      if (result && typeof result === 'object' && 'endpoint' in result && typeof result.endpoint === 'string') setEndpoint(result.endpoint);
      setEnabled(!enabled);
    }).catch(error => {
      if (isCurrent() && !(error instanceof DOMException && error.name === 'AbortError')) report.current(error);
    }).finally(() => { if (isCurrent()) setPending(false); });
  }

  if (!supported) return null;
  return <button className="icon-button" aria-label={enabled ? '알림 끄기' : '알림 켜기'} aria-pressed={enabled}
    disabled={!active || pending || (!enabled && !publicKey)} onClick={toggle}>
    <svg width="20" height="20" viewBox="0 0 24 24" fill={enabled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
      <path d="M10 21h4" />{!enabled && <path d="m3 3 18 18" />}
    </svg>
  </button>;
}
