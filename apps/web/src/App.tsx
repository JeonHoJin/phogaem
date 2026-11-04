import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import * as sharedApi from './server/api';
import { ApprovalRequired } from './server/api';
import type { Album, SharedMember } from './server/api';
import { registerPasskey, signInWithPasskey, passkeySupported } from './server/passkey';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import { MEMBERS, filterPhotos, formatBytes, matchesFilters } from './domain';
import type { MemberId, Photo, PhotoFilter } from './domain';
import { importPhotos, loadPhotos, loadPreferences, savePreferences, seedDemo, setDownloadState } from './storage';

type IconName = 'plus' | 'arrow' | 'download' | 'check' | 'close' | 'left' | 'right' | 'expand' | 'play' | 'pause' | 'image' | 'layers';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    arrow: <path d="M7 17 17 7M7 7h10v10" />,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    left: <path d="m15 5-7 7 7 7" />,
    right: <path d="m9 5 7 7-7 7" />,
    expand: <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />,
    play: <path d="m8 4 12 8-12 8Z" />,
    pause: <path d="M8 4v16M16 4v16" />,
    image: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8" cy="8" r="1" /><path d="m3 17 6-6 4 4 3-3 5 5" /></>,
    layers: <><path d="m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

const FILTERS: { id: PhotoFilter; label: string }[] = [
  { id: 'all', label: '모든 사진' }, { id: 'others', label: '친구 사진만' },
  { id: 'mine', label: '내가 올린 사진' }, { id: 'unreceived', label: '아직 안 받은 사진' },
  { id: 'duplicates', label: '중복 업로드' },
];

// Remote originals are loaded only near the viewport and released when off-screen.
// This map deduplicates in-flight reads; it does not retain all original blobs.
const originalReads = new Map<string, Promise<Blob>>();
const ApprovalContext = createContext<(error: ApprovalRequired) => void>(() => {});
async function originalBlob(photo: Photo): Promise<Blob> {
  if (photo.blob) return photo.blob;
  if (!photo.albumId) throw new Error('사진의 보관함을 찾지 못했어요.');
  const key = `${photo.albumId}:${photo.id}`;
  let pending = originalReads.get(key);
  if (!pending) {
    pending = sharedApi.getPhotoBlob(photo.albumId, photo.id).finally(() => originalReads.delete(key));
    originalReads.set(key, pending);
  }
  return pending;
}

function Preview({ photo, large = false }: { photo: Photo; large?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const onApprovalRequired = useContext(ApprovalContext);
  const [near, setNear] = useState(!!photo.blob || large);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (photo.blob || large || !container.current) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '150px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [photo.blob, large]);
  useEffect(() => {
    if (!near) { setUrl(''); return; }
    let active = true;
    let objectUrl = '';
    setError(''); setDecodeFailed(false);
    originalBlob(photo).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApprovalRequired) onApprovalRequired(reason);
      else setError('사진을 불러오지 못했어요.');
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photo.id, photo.albumId, photo.blob, near, retry, onApprovalRequired]);
  return <div ref={container} className="preview-container">{error || decodeFailed ? <div className="preview-fallback"><Icon name="image" size={large ? 52 : 30} /><span>{error || '미리보기를 지원하지 않는 사진'}</span><small>원본은 그대로 보관되어 있어요</small>{error && <span className="preview-retry" role="status">새로고침하거나 사진을 다시 열어 주세요.</span>}{error && large && <button className="button secondary" onClick={() => setRetry(retry + 1)}>다시 시도</button>}</div>
    : url ? <img src={url} alt={photo.name} loading={large ? 'eager' : 'lazy'} onError={() => setDecodeFailed(true)} /> : <span className="preview-loading"><Icon name="image" size={large ? 40 : 24} /><span>사진 불러오는 중</span></span>}</div>;
}

function PhotoCard({ photo, member, members, selected, onSelect, onView }: { photo: Photo; member: MemberId; members: SharedMember[]; selected: boolean; onSelect: () => void; onView: () => void }) {
  const received = photo.receivedBy.includes(member);
  const duplicate = (photo.importCount ?? photo.contributors.length) > 1;
  return <article className={`photo-card ${selected ? 'is-selected' : ''}`}>
    <div className="photo-frame">
      <button className="photo-open" onClick={onView} aria-label={`${photo.name} 크게 보기`}><Preview photo={photo} /></button>
      <button className="photo-select" aria-label={`${photo.name} 선택`} aria-pressed={selected} onClick={onSelect}>{selected && <Icon name="check" size={15} />}</button>
      {duplicate && <span className="photo-badge duplicate"><Icon name="layers" size={13} />중복 {photo.importCount ?? photo.contributors.length}</span>}
      {received && <span className="photo-badge received"><Icon name="check" size={13} />받았음</span>}
    </div>
    <div className="photo-info"><span className="photo-name" title={photo.name}>{photo.name}</span><span className="photo-size">{formatBytes(photo.size)}</span></div>
    <div className="photo-meta"><span>{photo.contributors.map(id => members.find(m => m.id === id)?.name ?? id).join(' · ')}</span><span>{photo.requestedBy.includes(member) && !received ? '다운로드 요청됨' : '원본'}</span></div>
  </article>;
}

function Modal({ children, label, onClose, className = '' }: { children: ReactNode; label: string; onClose: () => void; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const dialog = ref.current!;
    const previous = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={className} aria-label={label} onCancel={event => { event.preventDefault(); closeRef.current(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>{children}</dialog>;
}

function Viewer({ photos, initialId, onClose, onDownload, onNotice }: { photos: Photo[]; initialId: string; onClose: () => void; onDownload: (id: string) => void; onNotice: (text: string) => void }) {
  const [index, setIndex] = useState(Math.max(0, photos.findIndex(p => p.id === initialId)));
  const [playing, setPlaying] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const photo = photos[index % photos.length];
  const move = (delta: number) => setIndex(i => (i + delta + photos.length) % photos.length);
  useEffect(() => {
    if (!playing || photos.length < 2) return;
    const timer = window.setInterval(() => setIndex(i => (i + 1) % photos.length), 4000);
    return () => window.clearInterval(timer);
  }, [playing, photos.length]);
  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (container.current?.requestFullscreen) await container.current.requestFullscreen();
      else onNotice('이 브라우저에서는 전체 화면을 지원하지 않아요.');
    } catch { onNotice('전체 화면을 열지 못했어요. 브라우저 권한을 확인해 주세요.'); }
  }
  return <Modal label="사진 크게 보기" onClose={onClose} className="viewer-dialog">
    <div ref={container} className="viewer" onKeyDown={event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    }}>
      <header className="viewer-header"><div><strong>{photo.name}</strong><span>{index + 1} / {photos.length} · {formatBytes(photo.size)}</span></div><div className="viewer-actions">
        <button className="icon-button" onClick={() => setPlaying(!playing)} aria-label={playing ? '슬라이드쇼 일시정지' : '슬라이드쇼 시작'} aria-pressed={playing}><Icon name={playing ? 'pause' : 'play'} /></button>
        <button className="icon-button" onClick={fullscreen} aria-label="전체 화면"><Icon name="expand" /></button>
        <button className="icon-button" onClick={() => onDownload(photo.id)} aria-label="이 사진 다운로드"><Icon name="download" /></button>
        <button className="icon-button" onClick={onClose} aria-label="뷰어 닫기"><Icon name="close" /></button>
      </div></header>
      <div className="viewer-stage"><button className="icon-button viewer-prev" onClick={() => move(-1)} disabled={photos.length < 2} aria-label="이전 사진"><Icon name="left" size={28} /></button><Preview key={photo.id} photo={photo} large /><button className="icon-button viewer-next" onClick={() => move(1)} disabled={photos.length < 2} aria-label="다음 사진"><Icon name="right" size={28} /></button></div>
      <footer className="viewer-footer"><span>서로의 시선으로 다시 보는 여행</span><span>← → 이동 <span className="key-hint">ESC 닫기</span></span></footer>
    </div>
  </Modal>;
}

export default function App() {
  const [preferences] = useState(loadPreferences);
  const [localMember, setLocalMember] = useState<MemberId>(preferences.member);
  const [remote, setRemote] = useState<{ userId: string; albums: Album[]; album: Album | null; members: SharedMember[] } | null>(null);
  const [managerOpen, setManagerOpen] = useState(() => new URLSearchParams(location.hash.slice(1)).has('invite'));
  const [albumTitle, setAlbumTitle] = useState('우리의 여행');
  const [inviteToken, setInviteToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('invite') ?? '');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteExpires, setInviteExpires] = useState(0);
  const operation = useRef(false);
  const sourceEpoch = useRef(0);
  const [approvalCode, setApprovalCode] = useState<string | null>(null);
  const member = remote?.userId ?? localMember;
  const members = remote?.members ?? MEMBERS;
  const [filters, setFilters] = useState<PhotoFilter[]>(preferences.filters);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [downloadIds, setDownloadIds] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const activeMember = members.find(m => m.id === member) ?? { id: member, name: '나', color: '#c5d6c4' };
  const visible = useMemo(() => photos.filter(p => matchesFilters(p, filters, member)), [photos, filters, member]);
  const selectedPhotos = visible.filter(p => selected.has(p.id));
  const totalSize = photos.reduce((sum, p) => sum + p.size, 0);
  const duplicateCount = filterPhotos(photos, 'duplicates', member).length;
  const pendingPhotos = photos.filter(p => p.requestedBy.includes(member) && !p.receivedBy.includes(member));

  useEffect(() => {
    let active = true;
    loadPhotos().then(value => { if (active) setPhotos(value); }).catch(() => { if (active) setError('보관함을 열지 못했어요. 브라우저의 사이트 저장소 허용 여부를 확인해 주세요.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    try { savePreferences({ member: localMember, filters }); }
    catch { setError('화면 설정을 저장하지 못했어요. 사이트 저장소를 확인해 주세요.'); }
    setSelected(new Set());
  }, [localMember, filters]);

  const approvalDenied = useCallback((reason: ApprovalRequired) => {
    sourceEpoch.current += 1;
    originalReads.clear();
    setApprovalCode(reason.accountCode);
    setRemote(null); setPhotos([]); setSelected(new Set());
    setViewerId(null); setDownloadIds(null); setInviteLink('');
    setNotice(''); setError(reason.message); setManagerOpen(true);
  }, []);

  async function mutate(action: () => Promise<Photo[]>, success?: string) {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError('');
    const epoch = sourceEpoch.current;
    try {
      const next = await action();
      if (epoch === sourceEpoch.current) { setPhotos(next); if (success) setNotice(success); }
    } catch (reason) {
      if (reason instanceof ApprovalRequired) approvalDenied(reason);
      else if (epoch === sourceEpoch.current) setError(reason instanceof Error ? reason.message : '저장하지 못했어요. 저장 공간과 브라우저 설정을 확인해 주세요.');
    }
    finally { operation.current = false; setBusy(false); }
  }
  async function upload(files: File[]) {
    if (!files.length || busy || loading) return;
    await mutate(async () => {
      if (remote) {
        if (!remote.album) throw new Error('먼저 공유보관함을 만들거나 선택해 주세요.');
        try {
          const result = await sharedApi.uploadSharedPhotos(remote.album.id, files);
          setNotice(`${result.added}장 추가 · 중복 ${result.duplicates}장`);
        } catch (reason) {
          // Uploads commit per file: reflect successful earlier files even on a later failure.
          try { await refreshAlbum(remote.album.id); } catch (refreshError) { if (refreshError instanceof ApprovalRequired) throw refreshError; }
          throw reason;
        }
        return refreshAlbum(remote.album.id);
      }
      const result = await importPhotos(files, member);
      setNotice(`${result.added}장 추가${result.duplicates ? ` · 중복 ${result.duplicates}장은 원본 하나로 모았어요` : ''}`);
      return result.photos;
    });
  }
  function onFiles(event: ChangeEvent<HTMLInputElement>) { void upload(Array.from(event.target.files ?? [])); event.target.value = ''; }
  function drop(event: DragEvent) { event.preventDefault(); setDragging(false); void upload(Array.from(event.dataTransfer.files)); }
  function toggleFilter(filter: PhotoFilter) {
    if (filter === 'all') { setFilters(['all']); return; }
    setFilters(previous => {
      const next = previous.filter(f => f !== 'all');
      const result = next.includes(filter) ? next.filter(f => f !== filter) : [...next, filter];
      return result.length ? result : ['all'];
    });
  }
  function selectPhoto(id: string) { setSelected(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  async function download(photo: Photo) {
    await mutate(async () => {
      const blob = await originalBlob(photo);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = photo.name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return downloadState([photo.id], 'requested');
    }, '다운로드를 요청했어요. 파일을 확인한 뒤 ‘받았음’을 눌러 주세요.');
  }
  async function downloadState(ids: string[], state: 'requested' | 'received' | 'reset'): Promise<Photo[]> {
    if (!remote?.album) return setDownloadState(ids, member, state);
    await sharedApi.setSharedDownloadState(remote.album.id, ids, state);
    return refreshAlbum(remote.album.id);
  }
  async function refreshAlbum(id: string): Promise<Photo[]> {
    const result = await sharedApi.getAlbum(id);
    if (remote?.album?.id !== id) setPhotos([]);
    setRemote(previous => previous ? { ...previous, album: result.album, members: result.members } : previous);
    return result.photos.map(photo => ({ ...photo, albumId: id }));
  }
  function clearTransient() {
    setSelected(new Set()); setViewerId(null); setDownloadIds(null); setInviteLink(''); setNotice('');
  }
  async function connectShared(passkey = false) {
    await mutate(async () => {
      if (passkey) await signInWithPasskey();
      const result = await sharedApi.listAlbums();
      setApprovalCode(null);
      setRemote({ ...result, album: null, members: [] });
      clearTransient();
      return [];
    }, '연결했어요. 보관함을 만들거나 초대 코드로 참여해 주세요.');
  }
  async function selectAlbum(id: string) {
    if (!id) return;
    await mutate(async () => { clearTransient(); return refreshAlbum(id); });
  }
  async function createSharedAlbum() {
    await mutate(async () => {
      const album = await sharedApi.createAlbum(albumTitle.trim());
      const result = await sharedApi.listAlbums();
      setRemote(previous => previous ? { ...previous, albums: result.albums } : previous);
      const loaded = await refreshAlbum(album.id);
      clearTransient(); setManagerOpen(false);
      return loaded;
    }, '새 공유보관함을 만들었어요. 초대 링크로 친구들을 불러보세요.');
  }
  async function joinSharedAlbum() {
    await mutate(async () => {
      let token = inviteToken.trim();
      if (token.includes('#')) token = new URLSearchParams(token.split('#')[1]).get('invite') ?? '';
      if (!token) throw new Error('초대 코드를 입력해 주세요.');
      const album = await sharedApi.joinInvite(token);
      const result = await sharedApi.listAlbums();
      setRemote(previous => previous ? { ...previous, albums: result.albums } : previous);
      const loaded = await refreshAlbum(album.id);
      clearTransient(); setManagerOpen(false); setInviteToken('');
      history.replaceState(null, '', location.pathname + location.search);
      return loaded;
    }, '보관함에 참여했어요. 함께 사진을 모아보세요.');
  }
  async function invite() {
    if (!remote?.album) return;
    await mutate(async () => {
      const result = await sharedApi.createInvite(remote.album!.id);
      const url = new URL(import.meta.env.BASE_URL, location.origin);
      url.hash = new URLSearchParams({ invite: result.token }).toString();
      setInviteLink(url.href); setInviteExpires(result.expiresAt); setManagerOpen(true);
      return photos;
    });
  }
  async function returnLocal() {
    await mutate(async () => {
      const local = await loadPhotos();
      setRemote(null); setApprovalCode(null); clearTransient(); setManagerOpen(false);
      return local;
    });
  }

  return <ApprovalContext.Provider value={approvalDenied}><div className="app-shell" onDragOver={event => { event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }}>
    <header className="site-header"><a className="brand" href={import.meta.env.BASE_URL} aria-label="포갬 홈"><span className="brand-mark"><i /><i /></span><span>phogaem<span className="brand-dot">.</span></span></a><div className="header-right"><span className="local-pill"><span />{remote ? '공유보관함 연결됨' : '이 브라우저에 보관 중'}</span><span className="avatar" style={{ background: activeMember.color }}>{activeMember.name.slice(0, 1)}</span></div></header>

    <main>
      <div className="breadcrumb">우리의 보관함 <span>/</span> 여행 사진</div>
      <section className="album-heading" aria-labelledby="album-title">
        <div><div className="eyebrow">A LITTLE TRIP, ALL OUR PERSPECTIVES</div><h1 id="album-title">{remote ? (remote.album?.title ?? '우리의 공유보관함') : <>함께 다녀온, <span>그 여행.</span></>}</h1><p className="album-description">각자의 카메라에 담긴 순간을 한곳에.<br className="mobile-break" /> 필요한 사진만 골라 가져가세요.</p><div className="album-stats"><div className="avatar-stack" aria-hidden="true">{members.map(m => <span key={m.id} className="avatar" style={{ background: m.color }}>{m.name.slice(0, 1)}</span>)}</div><span>{remote ? members.length : 4}명의 시선</span><span className="stat-dot">·</span><span>{photos.length}장의 원본</span><span className="stat-dot">·</span><span>{formatBytes(totalSize)}</span></div></div>
        <div className="heading-actions"><span className="small-caption">좋았던 순간, 빠짐없이 포개기</span><button className="button primary" onClick={() => fileInput.current?.click()} disabled={busy || loading || (!!remote && !remote.album)}><Icon name="plus" />{busy ? '사진 정리 중…' : '사진 올리기'}</button></div>
      </section>

      {!remote && <div className="local-note"><span className="note-icon"><Icon name="layers" size={18} /></span><div><strong>먼저, 우리끼리 써볼 준비 중이에요.</strong><span>지금 사진은 이 기기의 브라우저에만 저장돼요. 사용자 전환으로 필터를 미리 살펴볼 수 있어요.</span></div><label className="member-select">미리보기 사용자<select aria-label="미리보기 사용자" value={localMember} disabled={busy} onChange={event => { setLocalMember(event.target.value as MemberId); setDownloadIds(null); }} >{MEMBERS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label></div>}
      <div className="shared-toolbar">{remote ? <><label>공유보관함<select aria-label="공유보관함 선택" value={remote.album?.id ?? ''} disabled={busy} onChange={event => void selectAlbum(event.target.value)}><option value="" disabled>보관함을 선택해 주세요</option>{remote.albums.map(album => <option key={album.id} value={album.id}>{album.title}</option>)}</select></label><div className="shared-toolbar-actions"><button className="text-button" disabled={busy || !remote.album} onClick={() => void selectAlbum(remote.album!.id)}>새로고침</button><button className="text-button" disabled={busy || !remote.album} onClick={() => void invite()}>초대 링크 만들기</button><button className="text-button" disabled={busy} onClick={() => setManagerOpen(true)}>보관함 관리</button><button className="text-button" disabled={busy} onClick={() => void returnLocal()}>이 기기 보관함으로</button></div></> : <><span>친구들과 같은 보관함을 사용하고 싶다면</span><button className="text-button" disabled={busy || loading} onClick={() => setManagerOpen(true)}>공유보관함 연결 <Icon name="arrow" size={16} /></button></>}</div>

      {error && <div className="message error" role="alert"><span>{error}</span><button className="icon-button" aria-label="오류 닫기" onClick={() => setError('')}><Icon name="close" size={16} /></button></div>}
      <div className="message-slot" role="status" aria-live="polite">{notice && <div className="message success"><span>{notice}</span><button className="icon-button" aria-label="알림 닫기" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}</div>

      <section className="library" aria-label="사진 보관함">
        <div className="library-top"><div className="section-title"><h2>모인 순간들</h2><span>{photos.length}</span></div><button className="text-button" disabled={!pendingPhotos.length || busy} onClick={() => setDownloadIds(pendingPhotos.map(p => p.id))}><Icon name="download" size={16} />다운로드 기록 {pendingPhotos.length > 0 && <span className="count-dot">{pendingPhotos.length}</span>}</button></div>
        <div className="filter-row"><div className="filter-chips" aria-label="사진 필터">{FILTERS.map(filter => <button key={filter.id} className={`filter-chip ${filters.includes(filter.id) ? 'active' : ''}`} aria-pressed={filters.includes(filter.id)} onClick={() => toggleFilter(filter.id)}>{filter.label}{filter.id === 'duplicates' && duplicateCount > 0 && <span>{duplicateCount}</span>}</button>)}</div></div>
        <div className="selection-row"><div><label className="select-all"><input type="checkbox" aria-label="현재 사진 전체 선택" checked={visible.length > 0 && visible.every(p => selected.has(p.id))} disabled={!visible.length || busy} onChange={event => setSelected(event.target.checked ? new Set(visible.map(p => p.id)) : new Set())} />전체 선택</label><span className="visible-count">{visible.length}장{filters.filter(f => f !== 'all').length > 1 ? ' · 선택한 조건 모두 적용' : ''}</span></div><span className="original-note">원본 그대로, 중복은 하나로</span></div>

        {remote && !remote.album ? <div className="empty-state"><Icon name="layers" size={38} /><h3>함께 쓸 보관함을 골라주세요</h3><p>새 보관함을 만들거나 친구의 초대 코드로 참여할 수 있어요.</p><button className="button primary" disabled={busy} onClick={() => setManagerOpen(true)}>공유보관함 관리</button></div> : loading ? <div className="empty-state"><span className="loading-dot" /><h3>보관함을 열고 있어요</h3></div> : photos.length === 0 ? <div className="empty-state first-empty"><div className="empty-art" aria-hidden="true"><span /><span /><Icon name="image" size={45} /></div><div className="eyebrow">EVERY TRIP HAS MORE THAN ONE STORY</div><h3>우리의 첫 사진을 포개볼까요?</h3><p>사진을 끌어 놓거나 파일을 선택해 주세요.<br />같은 사진은 알아서 하나로 모아드려요.</p><button className="button primary" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="plus" />첫 사진 올리기</button>{!remote && <button className="text-button sample-button" disabled={busy} onClick={() => void mutate(seedDemo, '샘플 일러스트를 불러왔어요. 실제 여행 사진은 아니에요.')}>샘플 보관함 둘러보기 <Icon name="arrow" size={15} /></button>}<small>JPEG, PNG, WebP, HEIC 등 · 파일당 최대 {remote ? 16 : 50}MB</small></div> : !visible.length ? <div className="empty-state"><Icon name="image" size={38} /><h3>이 조건에 맞는 사진이 없어요</h3><p>조건을 줄이면 더 많은 순간을 볼 수 있어요.</p><button className="button secondary" onClick={() => setFilters(['all'])}>필터 초기화</button></div> : <div className="photo-grid">{visible.map(photo => <PhotoCard key={photo.id} photo={photo} member={member} members={members} selected={selected.has(photo.id)} onSelect={() => selectPhoto(photo.id)} onView={() => setViewerId(photo.id)} />)}<button className="add-card" disabled={busy} onClick={() => fileInput.current?.click()}><span><Icon name="plus" size={28} /></span><strong>아직 남은 순간이 있나요?</strong><small>사진 더 올리기</small></button></div>}
      </section>
      <footer className="site-footer"><span>각자의 사진을, 하나의 여행으로.</span><span>포갬 · Phogaem</span></footer>
    </main>
    <input ref={fileInput} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,image/gif,.heic,.heif" aria-label="사진 파일 선택" onChange={onFiles} />
    {selectedPhotos.length > 0 && <aside className="download-tray" aria-label="선택한 사진"><div className="tray-count"><span>{selectedPhotos.length}</span><div><strong>장의 순간을 골랐어요</strong><small>{formatBytes(selectedPhotos.reduce((s, p) => s + p.size, 0))} · 원본 파일</small></div></div><div className="tray-actions"><button className="text-button" onClick={() => setSelected(new Set())}>선택 해제</button><button className="button primary" onClick={() => setDownloadIds(selectedPhotos.map(p => p.id))} disabled={busy}><Icon name="download" />선택 다운로드</button></div></aside>}
    {dragging && <div className="drop-overlay" onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={drop}><Icon name="plus" size={48} /><h2>여기에 순간을 놓아주세요</h2><p>사진 원본을 이 보관함에 추가할게요</p></div>}
    {viewerId && visible.length > 0 && <Viewer photos={visible} initialId={viewerId} onClose={() => setViewerId(null)} onDownload={id => { setViewerId(null); setDownloadIds([id]); }} onNotice={setNotice} />}
    {downloadIds && <Modal label="선택 사진 다운로드" onClose={() => setDownloadIds(null)} className="download-dialog"><header className="dialog-header"><div><div className="eyebrow">TAKE YOUR MOMENTS HOME</div><h2>사진 가져가기</h2></div><button className="icon-button" aria-label="다운로드 창 닫기" onClick={() => setDownloadIds(null)}><Icon name="close" /></button></header><p className="dialog-description">각 원본을 눌러 다운로드해 주세요.<br />기기에 저장된 파일을 확인한 뒤 ‘받았음’을 표시할 수 있어요.</p><div className="download-list">{downloadIds.map(id => photos.find(p => p.id === id)).filter((p): p is Photo => !!p).map(photo => <div key={photo.id} className="download-item"><div className="download-thumb"><Preview photo={photo} /></div><div className="download-item-info"><strong>{photo.name}</strong><small>{formatBytes(photo.size)} · {photo.receivedBy.includes(member) ? '받았음 확인' : photo.requestedBy.includes(member) ? '다운로드 요청됨' : '아직 요청하지 않음'}</small><div className="receipt-actions">{photo.requestedBy.includes(member) && !photo.receivedBy.includes(member) && <button disabled={busy} onClick={() => void mutate(() => downloadState([photo.id], 'received'), '받았음으로 표시했어요.')}>받았음 확인</button>}{photo.requestedBy.includes(member) && <button disabled={busy} onClick={() => void mutate(() => downloadState([photo.id], 'reset'), '다운로드 기록을 되돌렸어요.')}>기록 되돌리기</button>}</div></div><button className="icon-button outlined" disabled={busy} aria-label={`${photo.name} 원본 다운로드`} onClick={() => void download(photo)}><Icon name="download" /></button></div>)}</div><p className="dialog-footnote">다운로드 취소·실패 시 받았음을 표시하지 마세요. 이 기록은 현재 사용자에게만 적용돼요.</p></Modal>}
    {managerOpen && <Modal label="공유보관함 관리" onClose={() => { if (!busy) setManagerOpen(false); }} className="download-dialog shared-dialog">
      <header className="dialog-header"><div><div className="eyebrow">OUR MOMENTS, TOGETHER</div><h2>공유보관함</h2></div><button className="icon-button" disabled={busy} aria-label="공유보관함 관리 닫기" onClick={() => setManagerOpen(false)}><Icon name="close" /></button></header>
      <p className="dialog-description">{remote ? '초대받은 멤버끼리 원본을 함께 모아요. 사진은 연결한 서버에 저장돼요.' : '버튼을 누르면 이 기기의 키로 로그인해요. 기존 계정이 있다면 패스키로 연결할 수 있어요.'}</p>
      {error && <p className="message error" role="alert">{error}</p>}
      {!remote ? <div className="connect-actions">
        {approvalCode !== null && <section className="approval-pending" aria-label="계정 승인 대기"><h3>승인 대기 중</h3><p>관리자가 이 계정을 승인하면 공유보관함을 사용할 수 있어요.</p><label>계정 코드<output aria-label="계정 코드">{approvalCode || '확인할 수 없음'}</output></label><small>이미 다른 웹앱에서 승인받았다면 아래 패스키로 기존 계정에 연결해 주세요. 초대 링크만으로 계정 승인을 대신할 수는 없어요.</small></section>}
        <button className="button primary" disabled={busy || !passkeySupported()} onClick={() => void connectShared(true)}>패스키로 기존 계정 연결</button>
        <button className="button secondary" disabled={busy} onClick={() => void connectShared()}>{approvalCode === null ? '이 기기로 연결' : '승인 상태 다시 확인'}</button>
        {approvalCode !== null && <><button className="button secondary" disabled={busy || !passkeySupported()} onClick={() => void mutate(async () => { await registerPasskey(); return []; }, '패스키를 등록했어요. 관리자 승인 후 같은 계정으로 연결할 수 있어요.')}>기기 연결용 패스키 등록</button><button className="text-button" disabled={busy} onClick={() => void returnLocal()}>이 기기 보관함으로</button></>}
        <small>기존 계정의 패스키와 승인은 같은 mlhops 서버·사이트를 쓰는 앱에서 공유돼요. ‘이 기기로 연결’로 새로 만든 계정은 별도 승인이 필요해요.</small>
      </div> : <>
        <form className="shared-form" onSubmit={event => { event.preventDefault(); void createSharedAlbum(); }}><label htmlFor="album-name">새 여행 보관함</label><div><input id="album-name" aria-label="보관함 이름" value={albumTitle} maxLength={80} required onChange={event => setAlbumTitle(event.target.value)} disabled={busy} /><button className="button primary" disabled={busy || !albumTitle.trim()}>공유보관함 만들기</button></div></form>
        <form className="shared-form" onSubmit={event => { event.preventDefault(); void joinSharedAlbum(); }}><label htmlFor="invite-token">친구에게 초대받았나요?</label><input id="invite-token" aria-label="초대 코드" placeholder="초대 코드 또는 링크 붙여넣기" value={inviteToken} onChange={event => setInviteToken(event.target.value)} maxLength={2048} required disabled={busy} /><button className="button secondary" disabled={busy || !inviteToken.trim()}>초대 코드로 참여</button></form>
        {inviteLink && <div className="shared-form"><label htmlFor="share-link">친구에게 보낼 초대 링크</label><input id="share-link" aria-label="초대 링크" value={inviteLink} readOnly onFocus={event => event.target.select()} /><small>{new Date(inviteExpires).toLocaleString('ko-KR')}까지 참여 가능 · 링크를 받은 사람은 보관함에 참여할 수 있어요.</small><button className="button secondary" onClick={async () => { try { await navigator.clipboard.writeText(inviteLink); setNotice('초대 링크를 복사했어요.'); } catch { setError('복사하지 못했어요. 링크를 선택해 직접 복사해 주세요.'); } }}>초대 링크 복사</button></div>}
        <div className="shared-form"><span>다른 기기에서도 같은 계정을 쓰려면</span><button className="button secondary" disabled={busy || !passkeySupported()} onClick={() => void mutate(async () => { await registerPasskey(); return photos; }, '패스키를 등록했어요. 다른 기기에서 기존 계정으로 연결할 수 있어요.')}>기기 연결용 패스키 등록</button><small>계정 {remote.userId.slice(0, 8)} · 로그인 토큰은 브라우저 메모리에만 보관해요.</small></div>
      </>}
    </Modal>}

  </div></ApprovalContext.Provider>;
}
