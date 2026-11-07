import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { PhotoGrid } from './PhotoGrid';
import * as sharedApi from './server/api';
import { ApprovalRequired } from './server/api';
import type { Album, SharedMember, SimilarPhotos } from './server/api';
import { registerPasskey, signInWithPasskey, passkeySupported } from './server/passkey';
import { beginGoogleAuth, GOOGLE_LOGIN_ENABLED } from './server/google';
import googleSignInIcon from './assets/google-sign-in.svg';
import type { ChangeEvent, DragEvent, ReactNode } from 'react';
import { server, ServerError } from './server/index';
import { createPhotoArchive, validateArchiveSize, MAX_ARCHIVE_BYTES } from './archive';
import { MEMBERS, defaultAlbumName, mergeUploadedPhoto, filterPhotos, formatBytes, matchesFilters, buildPhotoStacks, representativeDownloadIds } from './domain';
import type { MemberId, Photo, PhotoFilter, ProcessingKind, ProcessingJob } from './domain';
import { validateFile as validateLocalFile, importPhotos, loadPhotos, loadPreferences, savePreferences, seedDemo, setDownloadState } from './storage';

type IconName = 'plus' | 'arrow' | 'download' | 'check' | 'close' | 'left' | 'right' | 'expand' | 'play' | 'pause' | 'image' | 'layers' | 'lock' | 'retry' | 'alert' | 'copy' | 'user' | 'clock' | 'sparkles' | 'star' | 'minus';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    minus: <path d="M5 12h14" />,
    star: <path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4-5.7-3-5.7 3 1.1-6.4-4.6-4.5 6.4-.9Z" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z" /><path d="M20 2v4m-2-2h4" /></>,
    lock: <><rect x="5" y="10" width="14" height="11" rx="3" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
    retry: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 8a7 7 0 0 1 12-2l2 3M4 15l2 3a7 7 0 0 0 12-2" /></>,
    alert: <><path d="M12 3 2 21h20Z" /><path d="M12 9v5m0 3v1" /></>,
    copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M15 8V3H3v13h5" /></>,
    user: <><circle cx="12" cy="8" r="4" /><path d="M4 22v-3a8 8 0 0 1 16 0v3" /></>,
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

function gridColumnLimit() {
  return window.innerWidth < 600 ? Math.max(2, Math.min(6, Math.floor((window.innerWidth * 0.88 + 5) / 49))) : 8;
}

const RESUME_KEY = `phogaem:${import.meta.env.BASE_URL}:resume-shared`;

const FILTERS: { id: PhotoFilter; label: string }[] = [
  { id: 'all', label: '전체' }, { id: 'others', label: '내 사진 제외' },
  { id: 'mine', label: '내 사진' }, { id: 'unreceived', label: '받은 사진 제외' },
  { id: 'duplicates', label: '중복' },
];

// Remote originals are loaded only near the viewport and released when off-screen.
// This map deduplicates in-flight reads; it does not retain all original blobs.
const originalReads = new Map<string, Promise<Blob>>();
const thumbnailReads = new Map<string, Promise<Blob>>();
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

async function thumbnailBlob(photo: Photo): Promise<Blob> {
  if (!photo.albumId) throw new Error('사진의 보관함을 찾지 못했어요.');
  const key = `${photo.albumId}:${photo.id}`;
  let pending = thumbnailReads.get(key);
  if (!pending) {
    pending = sharedApi.getThumbnailBlob(photo.albumId, photo.id).finally(() => thumbnailReads.delete(key));
    thumbnailReads.set(key, pending);
  }
  return pending;
}

function Preview({ photo, large = false, thumbnailOnly = false }: { photo: Photo; large?: boolean; thumbnailOnly?: boolean }) {
  const container = useRef<HTMLDivElement>(null);
  const onApprovalRequired = useContext(ApprovalContext);
  const [near, setNear] = useState(!!photo.blob || large);
  const [url, setUrl] = useState('');
  const [error, setError] = useState('');
  const [decodeFailed, setDecodeFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const thumbnailState = !large && photo.albumId ? photo.processing?.thumbnail.state ?? (thumbnailOnly ? 'pending' : undefined) : undefined;
  useEffect(() => {
    if (photo.blob || large || !container.current) return;
    const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '150px' });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [photo.blob, large]);
  useEffect(() => {
    if (!near || (thumbnailState !== undefined && thumbnailState !== 'succeeded')) { setUrl(''); setError(''); setDecodeFailed(false); return; }
    let active = true;
    let objectUrl = '';
    setError(''); setDecodeFailed(false);
    (thumbnailState ? thumbnailBlob(photo) : originalBlob(photo)).then(blob => {
      if (!active) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(reason => {
      if (!active) return;
      if (reason instanceof ApprovalRequired) onApprovalRequired(reason);
      else setError('사진을 불러오지 못했어요.');
    });
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [photo.id, photo.albumId, photo.blob, thumbnailState, near, retry, onApprovalRequired]);
  return <div ref={container} className="preview-container">{thumbnailState && thumbnailState !== 'succeeded' ? <span className="preview-loading" role="img" aria-label={`${photo.name} 미리보기 ${thumbnailState === 'failed' ? '없음' : '준비 중'}`}><Icon name={thumbnailState === 'pending' ? 'clock' : thumbnailState === 'running' ? 'retry' : 'image'} size={32} /></span> : error || decodeFailed ? <div className="preview-fallback" role="img" aria-label="미리보기 없음"><Icon name={error ? 'alert' : 'image'} size={large ? 52 : 30} />{error && large && <button className="icon-button" aria-label="미리보기 재시도" onClick={() => setRetry(retry + 1)}><Icon name="retry" /></button>}</div>
    : url ? <img draggable={false} src={url} alt={photo.name} loading={large ? 'eager' : 'lazy'} onError={() => setDecodeFailed(true)} /> : <span className="preview-loading" aria-label="사진 불러오는 중"><Icon name="image" size={large ? 40 : 24} /></span>}</div>;
}

function ProcessingIndicator({ photo, kind, job, disabled, onRetry }: { photo: Photo; kind: ProcessingKind; job: ProcessingJob; disabled: boolean; onRetry: () => void }) {
  const label = `${photo.name} ${kind === 'thumbnail' ? '썸네일' : '사진 분석'} ${({ pending: '대기', running: '진행 중', succeeded: '완료', failed: '재시도' })[job.state]}`;
  const content = <><Icon name={kind === 'thumbnail' ? 'image' : 'sparkles'} size={15} /><Icon name={job.state === 'pending' ? 'clock' : job.state === 'running' || job.state === 'failed' ? 'retry' : 'check'} size={13} /></>;
  return job.state === 'failed' ? <button className="processing-state failed" aria-label={label} disabled={disabled} onClick={onRetry}>{content}</button> : <span className={`processing-state ${job.state}`} role="img" aria-label={label}>{content}</span>;
}

function PhotoCard({ photo, member, members, selected, onSelect, onView, onRetry, busy, stackCount = 1, stackPhotos = [], selectionMode = false }: { photo: Photo; selectionMode?: boolean; stackCount?: number; stackPhotos?: Photo[]; member: MemberId; members: SharedMember[]; selected: boolean; onSelect: () => void; onView: () => void; onRetry: (kind: ProcessingKind) => void; busy: boolean }) {
  const received = photo.receivedBy.includes(member);
  const duplicate = (photo.importCount ?? photo.contributors.length) > 1;
  return <article data-photo-id={photo.id} className={`photo-card ${selected ? 'is-selected' : ''} ${stackCount > 1 ? 'photo-stack' : ''}`}>
    {stackPhotos.slice(1, 3).reverse().map(value => <div key={value.id} className="photo-stack-layer" aria-hidden="true"><Preview photo={value} thumbnailOnly /></div>)}
    <div className="photo-frame">
      <button className="photo-open" disabled={busy && selectionMode} onClick={onView} aria-label={`${photo.name} ${selectionMode ? '선택 전환' : '크게 보기'}`} aria-pressed={selectionMode ? selected : undefined}><Preview photo={photo} /></button>
      <button className="photo-select" aria-label={`${photo.name} 선택`} aria-pressed={selected} disabled={busy} onClick={onSelect}>{selected && <Icon name="check" size={15} />}</button>
      {(duplicate || stackCount > 1) && <span className="photo-badge duplicate" aria-label={`중복 ${stackCount > 1 ? stackCount : photo.importCount ?? photo.contributors.length}`}><Icon name="layers" size={13} />{stackCount > 1 ? stackCount : photo.importCount ?? photo.contributors.length}</span>}
      {received && <span className="photo-badge received"><Icon name="check" size={13} /></span>}
    </div>
    <div className="photo-info"><span className="photo-name">{photo.name}</span><span className="photo-size">{formatBytes(photo.size)}</span></div>
    {photo.processing && <div className="processing-states" aria-label={`${photo.name} 처리 상태`}>{(['thumbnail', 'vision'] as const).map(kind => <ProcessingIndicator key={kind} photo={photo} kind={kind} job={photo.processing![kind]} disabled={busy} onRetry={() => onRetry(kind)} />)}</div>}
    <div className="photo-meta"><span>{photo.contributors.map(id => members.find(m => m.id === id)?.name ?? id).join(' · ')}</span><span aria-label={received ? '받았음 확인' : photo.requestedBy.includes(member) ? '다운로드 요청됨' : '원본'}>{photo.requestedBy.includes(member) && <Icon name={received ? 'check' : 'download'} size={14} />}</span></div>
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
  const [fullscreenFailed, setFullscreenFailed] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const photo = photos[index % photos.length];
  const move = (delta: number) => setIndex(i => (i + delta + photos.length) % photos.length);
  useEffect(() => {
    if (!playing || photos.length < 2) return;
    const timer = window.setInterval(() => setIndex(i => (i + 1) % photos.length), 4000);
    return () => window.clearInterval(timer);
  }, [playing, photos.length]);
  async function fullscreen() {
    setFullscreenFailed(false);
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (container.current?.requestFullscreen) await container.current.requestFullscreen();
      else { setFullscreenFailed(true); onNotice('이 브라우저에서는 전체 화면을 지원하지 않아요.'); }
    } catch { setFullscreenFailed(true); onNotice('전체 화면을 열지 못했어요. 브라우저 권한을 확인해 주세요.'); }
  }
  return <Modal label="사진 크게 보기" onClose={onClose} className="viewer-dialog">
    <div ref={container} className="viewer" onKeyDown={event => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); move(-1); }
      if (event.key === 'ArrowRight') { event.preventDefault(); move(1); }
    }}>
      <header className="viewer-header"><div><strong>{photo.name}</strong><span>{index + 1} / {photos.length} · {formatBytes(photo.size)}</span></div><div className="viewer-actions">
        <button className="icon-button" onClick={() => setPlaying(!playing)} aria-label={playing ? '슬라이드쇼 일시정지' : '슬라이드쇼 시작'} aria-pressed={playing}><Icon name={playing ? 'pause' : 'play'} /></button>
        <button className="icon-button" onClick={fullscreen} aria-label="전체 화면" aria-invalid={fullscreenFailed}><Icon name={fullscreenFailed ? 'alert' : 'expand'} /></button>
        <button className="icon-button" onClick={() => onDownload(photo.id)} aria-label="이 사진 다운로드"><Icon name="download" /></button>
        <button className="icon-button" onClick={onClose} aria-label="뷰어 닫기"><Icon name="close" /></button>
      </div></header>
      <div className="viewer-stage"><button className="icon-button viewer-prev" onClick={() => move(-1)} disabled={photos.length < 2} aria-label="이전 사진"><Icon name="left" size={28} /></button><Preview key={photo.id} photo={photo} large /><button className="icon-button viewer-next" onClick={() => move(1)} disabled={photos.length < 2} aria-label="다음 사진"><Icon name="right" size={28} /></button></div>

    </div>
  </Modal>;
}


function Comparison({ photos, selected, selectedCount, busy, initialPage, onSelect, onView, onDownload, onClose, representativeId, onRepresentative, failure }: {
  photos: Photo[]; selected: Set<string>; selectedCount: number; busy: boolean; initialPage: number;
  failure?: ReactNode; representativeId?: string; onRepresentative: (id: string) => void;
  onSelect: (id: string) => void; onView: (id: string, page: number) => void; onDownload: () => void; onClose: () => void;
}) {
  const [page, setPage] = useState(initialPage);
  const pages = Math.ceil(photos.length / 4);
  const current = Math.min(page, Math.max(0, pages - 1));
  const start = current > 0 && photos.length - current * 4 === 1 ? current * 4 - 1 : current * 4;
  const pagePhotos = photos.slice(start, current * 4 + 4);
  return <Modal label="사진 비교" onClose={onClose} className="comparison-dialog">
    <header className="dialog-header"><h2>비교</h2><div className="comparison-navigation">
      {pages > 1 && <><button className="icon-button" aria-label="이전 비교 사진" disabled={current === 0} onClick={() => setPage(current - 1)}><Icon name="left" /></button><output aria-label="비교 페이지">{current + 1}/{pages}</output><button className="icon-button" aria-label="다음 비교 사진" disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}><Icon name="right" /></button></>}
      <button className="icon-button" aria-label="비교 닫기" onClick={onClose}><Icon name="close" /></button>
    </div></header>
    {failure}
    <div className="comparison-grid" data-count={pagePhotos.length}>{pagePhotos.map(photo => <article key={photo.id} className={`comparison-photo ${selected.has(photo.id) ? 'is-selected' : ''}`}>
      <div className="comparison-open"><Preview photo={photo} thumbnailOnly /><button className="icon-button comparison-expand" aria-label={`${photo.name} 크게 보기`} onClick={() => onView(photo.id, current)}><Icon name="expand" /></button></div>
      <div className="comparison-photo-info"><span>{photo.name}</span><button className="icon-button" aria-label={`${photo.name} 대표사진`} aria-pressed={photo.id === representativeId} disabled={busy || photo.id === representativeId} onClick={() => onRepresentative(photo.id)}><Icon name="star" /></button><button className="button secondary" aria-label={`${photo.name} 비교 선택`} aria-pressed={selected.has(photo.id)} disabled={busy || !!representativeId && photo.id !== representativeId} onClick={() => onSelect(photo.id)}><Icon name={selected.has(photo.id) ? 'check' : 'plus'} />선택</button></div>
    </article>)}</div>
    <footer className="comparison-footer"><output aria-label="선택한 사진 수">{selectedCount}</output><button className="button primary" aria-label="선택 다운로드" disabled={busy || selectedCount === 0} onClick={onDownload}><Icon name="download" />선택 다운로드</button></footer>
  </Modal>;
}

export default function App({ initialAuthError = '' }: { initialAuthError?: string }) {
  const [preferences] = useState(loadPreferences);
  const [selectionMode, setSelectionMode] = useState(false);
  const [maxColumns, setMaxColumns] = useState(gridColumnLimit);
  const [columns, setColumns] = useState(() => Math.min(preferences.columns ?? (window.innerWidth < 600 ? 2 : window.innerWidth < 1100 ? 3 : 4), gridColumnLimit()));
  const [localMember, setLocalMember] = useState<MemberId>(preferences.member);
  const [remote, setRemote] = useState<{ userId: string; albums: Album[]; album: Album | null; members: SharedMember[] } | null>(null);
  const [localMode, setLocalMode] = useState(false);
  const [queuedFiles, setQueuedFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [rejectedFiles, setRejectedFiles] = useState<Set<File>>(new Set());
  const [nickname, setNickname] = useState('');
  const [ownerNickname, setOwnerNickname] = useState('');
  const [passkeyRegistered, setPasskeyRegistered] = useState(false);
  const [copied, setCopied] = useState(false);
  const retryAction = useRef<(() => Promise<Photo[]>) | null>(null);
  const [managerOpen, setManagerOpen] = useState(() => new URLSearchParams(location.hash.slice(1)).has('invite'));
  const [albumTitle, setAlbumTitle] = useState(defaultAlbumName);
  const suggestedTitle = useRef(albumTitle);
  const [incomingInvite, setIncomingInvite] = useState(() => new URLSearchParams(location.hash.slice(1)).has('invite'));
  const autoJoinAttempted = useRef(false);
  const [inviteFailure, setInviteFailure] = useState<'invalid' | 'full' | 'retry' | null>(null);
  const [inviteToken, setInviteToken] = useState(() => new URLSearchParams(location.hash.slice(1)).get('invite') ?? '');
  const [inviteLink, setInviteLink] = useState('');
  const [inviteExpires, setInviteExpires] = useState(0);
  const operation = useRef(false);
  const sourceEpoch = useRef(0);
  const mutationEpoch = useRef(0);
  const [approvalCode, setApprovalCode] = useState<string | null>(null);
  const member = remote?.userId ?? localMember;
  const members = remote?.members ?? MEMBERS;
  const [filters, setFilters] = useState<PhotoFilter[]>(preferences.filters);
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialAuthError);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [downloadIds, setDownloadIds] = useState<string[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [comparisonMode, setComparisonMode] = useState(false);
  const [candidates, setCandidates] = useState<SimilarPhotos | null>(null);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [candidatesError, setCandidatesError] = useState('');
  const [comparisonGroupId, setComparisonGroupId] = useState<string | null>(null);
  const [comparisonPage, setComparisonPage] = useState(0);
  const representativeRetryId = useRef<string | null>(null);
  const comparisonRequest = useRef(0);
  const candidatesRevision = useRef<string | null>(null);
  const returnComparisonId = useRef<string | null>(null);
  const clearComparison = useCallback(() => {
    comparisonRequest.current += 1; candidatesRevision.current = null; representativeRetryId.current = null;
    setComparisonMode(false); setCandidates(null); setCandidatesLoading(false); setCandidatesError('');
    setComparisonGroupId(null); setComparisonPage(0); returnComparisonId.current = null;
  }, []);
  const fileInput = useRef<HTMLInputElement>(null);
  const needsNickname = !!remote?.album && remote.members.find(value => value.id === remote.userId)?.nickname === null;
  const activeMember = members.find(m => m.id === member) ?? { id: member, name: '나', color: '#c5d6c4' };
  const similarIds = useMemo(() => {
    const known = new Set(photos.filter(photo => photo.albumId === remote?.album?.id).map(photo => photo.id));
    return new Set((candidates?.groups ?? []).flatMap(group => {
      const ids = group.photoIds.filter(id => known.has(id));
      return ids.length >= 2 ? ids : [];
    }));
  }, [photos, candidates, remote?.album?.id]);
  const stacks = useMemo(() => buildPhotoStacks(photos, candidates?.groups ?? []), [photos, candidates]);
  const filteredPhotos = useMemo(() => photos.filter(p => matchesFilters(p, filters, member, similarIds)), [photos, filters, member, similarIds]);
  const visible = useMemo(() => stacks.map(stack => stack.representative).filter(p => matchesFilters(p, filters, member, similarIds)), [stacks, filters, member, similarIds]);
  const downloadReady = !remote?.album || !!candidates && !candidatesLoading && !candidatesError;
  const normalizedDownloadIds = useMemo(() => downloadIds === null ? null : representativeDownloadIds(downloadIds, stacks), [downloadIds, stacks]);
  const visibleIds = useMemo(() => visible.map(photo => photo.id), [visible]);
  const selectedPhotos = visible.filter(p => selected.has(p.id));
  const totalSize = photos.reduce((sum, p) => sum + p.size, 0);
  const duplicateCount = filterPhotos(stacks.map(stack => stack.representative), 'duplicates', member, similarIds).length;
  const queuedValid = queuedFiles.length > 0 && queuedFiles.every(file => {
    try { if (rejectedFiles.has(file)) return false; if (remote) sharedApi.validateSharedFiles([file]); else validateLocalFile(file); return true; }
    catch { return false; }
  });
  const downloadSize = (normalizedDownloadIds ?? []).reduce((sum, id) => sum + (photos.find(photo => photo.id === id)?.size ?? 0), 0);
  const candidateGroups = useMemo(() => (candidates?.groups ?? []).map(group => {
    const ids = new Set(group.photoIds);
    const matches = filteredPhotos.filter(photo => photo.albumId === remote?.album?.id && ids.has(photo.id));
    return { id: group.id, photos: matches };
  }).filter(group => group.photos.length >= 2), [candidates, filteredPhotos, remote?.album?.id]);
  const comparisonPhotos = stacks.find(stack => stack.id === comparisonGroupId)?.photos ?? [];
  useEffect(() => {
    if (comparisonGroupId && comparisonPhotos.length < 2) setComparisonGroupId(null);
  }, [comparisonGroupId, comparisonPhotos.length]);
  const pendingPhotos = photos.filter(p => p.requestedBy.includes(member) && !p.receivedBy.includes(member));

  useEffect(() => {
    let active = true;
    const epoch = sourceEpoch.current;
    loadPhotos().then(value => { if (active && epoch === sourceEpoch.current) setPhotos(value); }).catch(() => { if (active && epoch === sourceEpoch.current) setError('보관함을 열지 못했어요. 브라우저의 사이트 저장소 허용 여부를 확인해 주세요.'); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    try { savePreferences({ member: localMember, filters, columns }); }
    catch { setError('화면 설정을 저장하지 못했어요. 사이트 저장소를 확인해 주세요.'); }
  }, [localMember, filters, columns]);
  useEffect(() => { setSelected(new Set()); }, [localMember, filters]);
  useEffect(() => {
    const resize = () => { const max = gridColumnLimit(); setMaxColumns(max); setColumns(value => Math.min(value, max)); };
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    let active = true;
    const epoch = sourceEpoch.current;
    void (async () => {
      try {
        if (initialAuthError || localStorage.getItem(RESUME_KEY) !== '1' || !await server.hasIdentity()) return;
        const result = await sharedApi.listAlbums();
        if (active && epoch === sourceEpoch.current) { sourceEpoch.current += 1; setPhotos([]); setRemote({ ...result, album: null, members: [] }); }
      } catch (reason) {
        if (!active || epoch !== sourceEpoch.current) return;
        if (reason instanceof ApprovalRequired) { setApprovalCode(reason.accountCode); setManagerOpen(true); }
        else setError(reason instanceof Error ? reason.message : '연결 실패');
      }
    })();
    return () => { active = false; };
  }, [initialAuthError]);

  const approvalDenied = useCallback((reason: ApprovalRequired) => {
    sourceEpoch.current += 1;
    clearComparison();
    originalReads.clear(); thumbnailReads.clear();
    setApprovalCode(reason.accountCode);
    setRemote(null); setPhotos([]); setSelected(new Set());
    setSelectionMode(false); setViewerId(null); setDownloadIds(null); setInviteLink('');
    retryAction.current = null; setNotice(''); setError(''); setManagerOpen(true); setLocalMode(false);
  }, [clearComparison]);

  const activeAlbumId = remote?.album?.id;
  const albumIdentity = useRef(activeAlbumId);
  albumIdentity.current = activeAlbumId;
  useEffect(() => {
    clearComparison();
    return () => { comparisonRequest.current += 1; };
  }, [activeAlbumId, clearComparison]);
  const visionRevision = photos.map(photo => `${photo.id}:${photo.processing?.vision.state ?? ''}`).sort().join('|');
  const loadCandidates = useCallback(async (showComparison = true) => {
    if (!activeAlbumId || operation.current) return;
    const request = ++comparisonRequest.current;
    const epoch = sourceEpoch.current;
    const revision = mutationEpoch.current;
    candidatesRevision.current = visionRevision;
    if (showComparison) { setComparisonMode(true); setCandidates(null); setComparisonGroupId(null); }
    setCandidatesLoading(true); setCandidatesError('');
    try {
      const result = await sharedApi.getSimilarPhotos(activeAlbumId);
      if (request !== comparisonRequest.current || epoch !== sourceEpoch.current || revision !== mutationEpoch.current || albumIdentity.current !== activeAlbumId || operation.current) return;
      setCandidates(result);
    } catch (reason) {
      if (request !== comparisonRequest.current || epoch !== sourceEpoch.current || albumIdentity.current !== activeAlbumId) return;
      if (reason instanceof ApprovalRequired) approvalDenied(reason);
      else setCandidatesError(reason instanceof Error ? reason.message : '비교 후보 조회 실패');
    } finally {
      if (request === comparisonRequest.current) setCandidatesLoading(false);
    }
  }, [activeAlbumId, visionRevision, approvalDenied]);
  const wantsCandidates = !!activeAlbumId;
  useEffect(() => {
    if (!activeAlbumId || busy || !wantsCandidates || candidatesLoading || candidatesRevision.current === visionRevision) return;
    void loadCandidates(false);
  }, [activeAlbumId, busy, wantsCandidates, candidatesLoading, visionRevision, loadCandidates]);
  const hasProcessing = photos.some(photo => photo.processing && Object.values(photo.processing).some(job => job.state === 'pending' || job.state === 'running'));
  useEffect(() => {
    if (!activeAlbumId || !hasProcessing) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const epoch = sourceEpoch.current;
    const poll = async () => {
      if (!active || epoch !== sourceEpoch.current || albumIdentity.current !== activeAlbumId) return;
      if (!operation.current) {
        const revision = mutationEpoch.current;
        try {
          const result = await sharedApi.getAlbum(activeAlbumId);
          if (!active || epoch !== sourceEpoch.current || albumIdentity.current !== activeAlbumId) return;
          if (!operation.current && revision === mutationEpoch.current) {
            setRemote(previous => previous?.album?.id === activeAlbumId ? { ...previous, album: result.album, members: result.members } : previous);
            setPhotos(result.photos.map(photo => ({ ...photo, albumId: activeAlbumId })));
            if (!result.photos.some(photo => photo.processing && Object.values(photo.processing).some(job => job.state === 'pending' || job.state === 'running'))) return;
          }
        } catch (reason) {
          if (!active || epoch !== sourceEpoch.current || albumIdentity.current !== activeAlbumId) return;
          if (reason instanceof ApprovalRequired) { approvalDenied(reason); return; }
          setError(reason instanceof Error ? reason.message : '처리 상태 조회 실패');
        }
      }
      if (active) timer = setTimeout(() => { void poll(); }, 4000);
    };
    timer = setTimeout(() => { void poll(); }, 4000);
    return () => { active = false; if (timer !== undefined) clearTimeout(timer); };
  }, [activeAlbumId, hasProcessing, approvalDenied]);

  async function mutate(action: () => Promise<Photo[]>, success?: string, changesSource = false, retryable = false) {
    if (operation.current) return;
    clearComparison();
    mutationEpoch.current += 1;
    operation.current = true; setBusy(true); setError(''); retryAction.current = retryable ? action : null;
    if (changesSource) sourceEpoch.current += 1;
    const epoch = sourceEpoch.current;
    try {
      const next = await action();
      if (epoch === sourceEpoch.current) { setPhotos(next); retryAction.current = null; if (success) setNotice(success); }
    } catch (reason) {
      if (reason instanceof ApprovalRequired) approvalDenied(reason);
      else if (epoch === sourceEpoch.current) setError(reason instanceof Error ? reason.message : '저장하지 못했어요. 저장 공간과 브라우저 설정을 확인해 주세요.');
    }
    finally { operation.current = false; setBusy(false); }
  }
  async function upload(files: File[]) {
    if (!files.length || busy || loading) return;
    const uploadEpoch = sourceEpoch.current;
    setQueuedFiles(files); setProgress({ done: 0, total: files.length });
    await mutate(async () => {
      if (remote) {
        if (!remote.album) throw new Error('먼저 공유보관함을 만들거나 선택해 주세요.');
        const completedIndices = new Set<number>();
        try {
          const result = await sharedApi.uploadSharedPhotos(remote.album.id, files, (done, event) => {
            if (uploadEpoch !== sourceEpoch.current) return;
            event.completedIndices.forEach(index => completedIndices.add(index));
            setProgress({ done, total: files.length });
            setQueuedFiles(files.filter((_, index) => !completedIndices.has(index)));
            setPhotos(current => mergeUploadedPhoto(current, { ...event.photo, albumId: remote.album!.id }));
          }, reason => { if (uploadEpoch === sourceEpoch.current && reason instanceof ApprovalRequired) approvalDenied(reason); });
          setNotice(`${result.added}장 추가 · 중복 ${result.duplicates}장`);
        } catch (reason) {
          if (reason instanceof ApprovalRequired) throw reason;
          if (reason instanceof ServerError && [400, 413, 415, 507].includes(reason.status) && sharedApi.getUploadFailureIndex(reason) !== undefined) {
            const rejected = files[sharedApi.getUploadFailureIndex(reason)!];
            if (rejected) setRejectedFiles(previous => new Set([...previous, rejected]));
          }
          // Uploads commit per file: reflect successful earlier files even on a later failure.
          try { const partial = await refreshAlbum(remote.album.id); if (uploadEpoch === sourceEpoch.current) setPhotos(partial); } catch (refreshError) { if (refreshError instanceof ApprovalRequired) throw refreshError; }
          throw reason;
        }
        setQueuedFiles([]); setProgress(null); return refreshAlbum(remote.album.id);
      }
      files.forEach(validateLocalFile);
      let added = 0; let duplicates = 0; let currentPhotos = photos;
      for (let index = 0; index < files.length; index += 1) {
        const result = await importPhotos([files[index]!], member);
        added += result.added; duplicates += result.duplicates; currentPhotos = result.photos;
        if (uploadEpoch !== sourceEpoch.current) return currentPhotos;
        setPhotos(currentPhotos); setProgress({ done: index + 1, total: files.length }); setQueuedFiles(files.slice(index + 1));
      }
      setQueuedFiles([]); setProgress(null);
      setNotice(`${added}장 추가 · 중복 ${duplicates}장`);
      return currentPhotos;
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
  async function resolveDownloadPhotos(ids: string[]): Promise<Photo[]> {
    if (!activeAlbumId) return representativeDownloadIds(ids, stacks).map(id => photos.find(photo => photo.id === id)).filter((photo): photo is Photo => !!photo);
    const albumId = activeAlbumId; const epoch = sourceEpoch.current;
    const result = await sharedApi.getAlbum(albumId);
    if (epoch !== sourceEpoch.current || albumIdentity.current !== albumId) throw new Error('보관함 변경');
    const fresh = await sharedApi.getSimilarPhotos(albumId);
    if (epoch !== sourceEpoch.current || albumIdentity.current !== albumId) throw new Error('보관함 변경');
    const latest: Photo[] = result.photos.map(photo => ({ ...photo, albumId }));
    const knownIds = new Set(latest.map(photo => photo.id));
    if (fresh.groups.some(group => group.representativeId && !knownIds.has(group.representativeId))) throw new ServerError(409, '사진 목록 변경');
    const currentStacks = buildPhotoStacks(latest, fresh.groups);
    comparisonRequest.current += 1;
    candidatesRevision.current = latest.map(photo => `${photo.id}:${photo.processing?.vision.state ?? ''}`).sort().join('|');
    setRemote(previous => previous?.album?.id === albumId ? { ...previous, album: result.album, members: result.members } : previous);
    setPhotos(latest); setCandidates(fresh); setCandidatesLoading(false); setCandidatesError('');
    setSelected(previous => new Set(representativeDownloadIds([...previous], currentStacks)));
    return representativeDownloadIds(ids, currentStacks).map(id => latest.find(photo => photo.id === id)).filter((photo): photo is Photo => !!photo);
  }
  async function download(photo: Photo) {
    if (!downloadReady) return;
    const requestedId = photo.id;
    await mutate(async () => {
      const target = (await resolveDownloadPhotos([requestedId]))[0];
      if (!target) throw new Error('다운로드할 사진 없음');
      const blob = await originalBlob(target);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = target.name;
      document.body.append(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return downloadState([target.id], 'requested');
    });
  }
  async function downloadState(ids: string[], state: 'requested' | 'received' | 'reset'): Promise<Photo[]> {
    if (!remote?.album) return setDownloadState(ids, member, state);
    await sharedApi.setSharedDownloadState(remote.album.id, ids, state);
    return refreshAlbum(remote.album.id);
  }
  async function refreshAlbum(id: string): Promise<Photo[]> {
    clearComparison();
    const result = await sharedApi.getAlbum(id);
    if (remote?.album?.id !== id) setPhotos([]);
    setRemote(previous => previous ? { ...previous, album: result.album, members: result.members } : previous);
    return result.photos.map(photo => ({ ...photo, albumId: id }));
  }
  async function retryPhotoProcessing(photo: Photo, kind: ProcessingKind) {
    if (!photo.albumId) return;
    await mutate(async () => {
      await sharedApi.retryProcessing(photo.albumId!, photo.id, kind);
      return refreshAlbum(photo.albumId!);
    });
  }
  const clearTransient = useCallback(() => {
    clearComparison();
    setSelectionMode(false); setSelected(new Set()); setViewerId(null); setDownloadIds(null); setInviteLink(''); setNotice(''); setCopied(false); setQueuedFiles([]); setProgress(null);
  }, [clearComparison]);
  function googleButton(link = false) {
    if (!GOOGLE_LOGIN_ENABLED) return null;
    return <button className="icon-button google-auth" aria-label={link ? 'Google 연결' : 'Google로 로그인'} disabled={busy || loading} onClick={() => {
      void mutate(async () => {
        await beginGoogleAuth(link ? remote?.userId : undefined, inviteToken);
        return photos;
      });
    }}><img src={googleSignInIcon} width="40" height="40" alt="" /></button>;
  }
  async function connectShared(passkey = false) {
    if (loading) return;
    await mutate(async () => {
      if (passkey) await signInWithPasskey();
      const result = await sharedApi.listAlbums();
      setApprovalCode(null);
      setRemote({ ...result, album: null, members: [] });
      clearTransient();
      autoJoinAttempted.current = false; setInviteFailure(null);
      setLocalMode(false); setManagerOpen(!!inviteToken);
      try { localStorage.setItem(RESUME_KEY, '1'); } catch { /* optional resume */ }
      return [];
    }, '연결했어요. 보관함을 만들거나 초대 코드로 참여해 주세요.', true);
  }
  async function selectAlbum(id: string) {
    if (!id) return;
    await mutate(async () => { clearTransient(); return refreshAlbum(id); }, undefined, false, true);
  }
  function openManager() {
    const today = defaultAlbumName();
    const previousSuggestion = suggestedTitle.current;
    setAlbumTitle(current => current === previousSuggestion ? today : current);
    suggestedTitle.current = today;
    const ownName = remote?.members.find(value => value.id === remote.userId)?.nickname ?? '';
    setNickname(ownName); setOwnerNickname(ownName); setManagerOpen(true);
  }
  async function createSharedAlbum() {
    const ownName = ownerNickname.trim();
    if (!ownName || [...ownName].length > 24 || /\p{Cc}/u.test(ownerNickname)) { setError('닉네임 확인 필요'); return; }
    await mutate(async () => {
      const album = await sharedApi.createAlbum(albumTitle.trim(), ownName);
      const result = await sharedApi.listAlbums();
      setRemote(previous => previous ? { ...previous, albums: result.albums } : previous);
      const loaded = await refreshAlbum(album.id);
      clearTransient(); setManagerOpen(false);
      suggestedTitle.current = defaultAlbumName(); setAlbumTitle(suggestedTitle.current);
      return loaded;
    }, '새 공유보관함을 만들었어요. 초대 링크로 친구들을 불러보세요.');
  }
  const joinSharedAlbum = useCallback(async () => {
    if (operation.current || loading) return;
    operation.current = true; mutationEpoch.current += 1; sourceEpoch.current += 1;
    const epoch = sourceEpoch.current;
    setBusy(true); setError(''); setInviteFailure(null); clearComparison();
    try {
      let token = inviteToken.trim();
      if (token.includes('#')) token = new URLSearchParams(token.split('#')[1]).get('invite') ?? '';
      if (!token) throw new ServerError(404, '초대 없음');
      const album = await sharedApi.joinInvite(token);
      if (epoch !== sourceEpoch.current) return;
      const result = await sharedApi.listAlbums();
      if (epoch !== sourceEpoch.current) return;
      const loaded = await sharedApi.getAlbum(album.id);
      if (epoch !== sourceEpoch.current) return;
      setRemote({ ...result, album: loaded.album, members: loaded.members });
      setPhotos(loaded.photos.map(photo => ({ ...photo, albumId: album.id })));
      setLocalMode(false); setApprovalCode(null); clearTransient();
      setManagerOpen(false); setIncomingInvite(false); setInviteToken(''); setFilters(['all']);
      history.replaceState(null, '', location.pathname + location.search);
      try { localStorage.setItem(RESUME_KEY, '1'); } catch { /* optional resume */ }
    } catch (reason) {
      if (epoch !== sourceEpoch.current) return;
      if (reason instanceof ApprovalRequired) approvalDenied(reason);
      else {
        setInviteFailure(reason instanceof ServerError && [404, 410].includes(reason.status) ? 'invalid' : reason instanceof ServerError && reason.status === 409 ? 'full' : 'retry');
        setError(reason instanceof Error ? reason.message : '참여 실패'); setManagerOpen(true);
      }
    } finally { operation.current = false; setBusy(false); }
  }, [inviteToken, loading, clearComparison, clearTransient, approvalDenied]);
  useEffect(() => {
    if (!incomingInvite || !remote?.userId || busy || loading || autoJoinAttempted.current) return;
    autoJoinAttempted.current = true;
    void joinSharedAlbum();
  }, [incomingInvite, remote?.userId, busy, loading, joinSharedAlbum]);
  useEffect(() => {
    const acceptLink = () => {
      const token = new URLSearchParams(location.hash.slice(1)).get('invite');
      if (token === null) return;
      sourceEpoch.current += 1; autoJoinAttempted.current = false;
      setInviteToken(token); setIncomingInvite(true); setInviteFailure(null); setError('');
      clearTransient(); setManagerOpen(true);
    };
    window.addEventListener('hashchange', acceptLink);
    return () => window.removeEventListener('hashchange', acceptLink);
  }, [clearTransient]);
  function dismissManager() {
    if (busy) return;
    setManagerOpen(false);
    if (incomingInvite) {
      autoJoinAttempted.current = true; setIncomingInvite(false); setInviteToken(''); setInviteFailure(null); setError('');
      history.replaceState(null, '', location.pathname + location.search);
    }
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
      setRemote(null); setApprovalCode(null); clearTransient(); setManagerOpen(false); setLocalMode(true);
      setIncomingInvite(false); autoJoinAttempted.current = true;
      try { localStorage.removeItem(RESUME_KEY); } catch { /* optional resume */ }
      return local;
    }, undefined, true);
  }

  async function saveNickname() {
    if (!activeAlbumId) return;
    const value = nickname.trim();
    if (!value || [...value].length > 24 || /\p{Cc}/u.test(nickname)) { setError('닉네임 확인 필요'); return; }
    await mutate(async () => {
      await sharedApi.setMemberNickname(activeAlbumId, value);
      const next = await refreshAlbum(activeAlbumId); setNickname(value); return next;
    });
  }
  async function chooseRepresentative(photoId: string) {
    if (!activeAlbumId || !comparisonGroupId || operation.current) return;
    const albumId = activeAlbumId; const groupId = comparisonGroupId; representativeRetryId.current = photoId;
    const epoch = sourceEpoch.current; operation.current = true; mutationEpoch.current += 1; comparisonRequest.current += 1; candidatesRevision.current = visionRevision; setCandidatesLoading(false); setBusy(true); setError('');
    try {
      await sharedApi.setRepresentative(albumId, groupId, photoId);
      if (epoch !== sourceEpoch.current || albumIdentity.current !== albumId) return;
      representativeRetryId.current = null;
      setCandidates(previous => previous ? { ...previous, groups: previous.groups.map(group => group.id === groupId ? { ...group, representativeId: photoId } : group) } : previous);
      setSelected(previous => {
        const old = candidates?.groups.find(group => group.id === groupId);
        if (!old || !old.photoIds.some(id => previous.has(id))) return previous;
        return new Set([...previous].filter(id => !old.photoIds.includes(id)).concat(photoId));
      });
    } catch (reason) {
      if (epoch !== sourceEpoch.current) return;
      if (reason instanceof ApprovalRequired) approvalDenied(reason);
      else if (reason instanceof ServerError && reason.status === 409) {
        representativeRetryId.current = null; candidatesRevision.current = null;
        setComparisonGroupId(null); setCandidates(null); setCandidatesError(''); setError('사진 묶음 변경');
      } else setError(reason instanceof Error ? reason.message : '대표사진 변경 실패');
    } finally { operation.current = false; setBusy(false); }
  }
  async function downloadBatch() {
    if (!downloadReady) return;
    const ids = [...(downloadIds ?? [])];
    if (!ids.length) return;
    await mutate(async () => {
      const batch = await resolveDownloadPhotos(ids);
      if (!batch.length) throw new Error('다운로드할 사진 없음');
      validateArchiveSize(batch.map(photo => photo.size));
      setProgress({ done: 0, total: batch.length });
      try {
        const entries: { name: string; blob: Blob }[] = [];
        for (const photo of batch) {
          entries.push({ name: photo.name, blob: await originalBlob(photo) });
          setProgress({ done: entries.length, total: batch.length });
        }
        const blob = batch.length === 1 ? entries[0]!.blob : await createPhotoArchive(entries);
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a'); anchor.href = url;
        anchor.download = batch.length === 1 ? batch[0]!.name : 'phogaem.zip';
        document.body.append(anchor); anchor.click(); anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return downloadState(batch.map(photo => photo.id), 'requested');
      } finally { setProgress(null); }
    });
  }
  function errorControl() {
    if (!error) return null;
    return <div className="failure-controls" role="group" aria-label="작업 실패"><Icon name="alert" />
      {retryAction.current && <button className="icon-button" aria-label="재시도" disabled={busy} onClick={() => { const action = retryAction.current; if (action) void mutate(action, undefined, false, true); }}><Icon name="retry" /></button>}
      {queuedFiles.length > 0 && <button className="icon-button" aria-label="다시 선택" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="plus" /></button>}
      <button className="icon-button" aria-label="오류 닫기" onClick={() => setError('')}><Icon name="close" /></button></div>;
  }

  return <ApprovalContext.Provider value={approvalDenied}><div className="app-shell" onDragOver={event => { if (!localMode && !remote?.album) return; event.preventDefault(); if (event.dataTransfer.types.includes('Files')) setDragging(true); }}>
    <header className="site-header"><a className="brand" href={import.meta.env.BASE_URL} aria-label="포갬 홈"><span className="brand-mark"><i /><i /></span><span>phogaem<span className="brand-dot">.</span></span></a><div className="header-right">
      {localMode && <button className="text-button" onClick={() => { setLocalMode(false); setPhotos([]); }} disabled={busy}>보관함</button>}
      {remote && <button className="icon-button" aria-label="계정" disabled={busy} onClick={openManager}><Icon name="user" /></button>}
      {(remote || localMode) && <span className="avatar" style={{ background: activeMember.color }}>{activeMember.name.slice(0, 1)}</span>}
    </div></header>
    <div className="visually-hidden" role="alert">{error}</div><div className="visually-hidden" role="status" aria-live="polite">{notice}</div>
    <main aria-busy={busy || loading}>
      <section className="album-heading" aria-labelledby="album-title"><div><h1 id="album-title">{remote?.album?.title ?? (localMode ? '기기 보관함' : '보관함')}</h1>
        {(remote?.album || localMode) && <div className="album-stats"><div className="avatar-stack" aria-label="참여자">{members.map(m => <span key={m.id} className="avatar" aria-label={m.name} style={{ background: m.color }}>{m.name.slice(0, 1)}</span>)}</div><span>{photos.length}</span><span>·</span><span>{formatBytes(totalSize)}</span></div>}
      </div>{(localMode || remote?.album) && <button className="button primary" onClick={() => fileInput.current?.click()} disabled={busy || loading}><Icon name="plus" />올리기</button>}</section>
      {!remote && !localMode ? <section className="entry-surface" aria-label="로그인">
        {loading ? <span className="loading-dot" aria-label="불러오는 중" /> : <Icon name={approvalCode !== null ? 'lock' : 'layers'} size={64} />}
        <div className="entry-actions">{googleButton()}<button className="button primary" disabled={busy || loading || !passkeySupported()} onClick={() => void connectShared(true)}>로그인</button><button className="button secondary" disabled={busy || loading} onClick={() => void connectShared()}>시작</button></div>
        <button className="text-button" disabled={busy} onClick={() => void returnLocal()}>기기 보관함</button>{errorControl()}
      </section> : remote && !remote.album ? <section aria-label="여행 보관함 목록">
        <div className="list-actions"><button className="button primary" disabled={busy} onClick={openManager}><Icon name="plus" />만들기</button><button className="button secondary" disabled={busy} onClick={openManager}>참여</button><button className="icon-button" aria-label="보관함 목록 새로고침" disabled={busy} onClick={() => void connectShared()}><Icon name="retry" /></button></div>
        {errorControl()}<div className="album-grid">{remote.albums.map(album => <button className="album-card" key={album.id} disabled={busy} onClick={() => void selectAlbum(album.id)}><Icon name="layers" size={36} /><strong>{album.title}</strong><time>{new Date(album.createdAt).toLocaleDateString('ko-KR')}</time></button>)}</div>
      </section> : <>
        <div className="shared-toolbar">{remote ? <><select aria-label="공유보관함 선택" value={remote.album?.id ?? ''} disabled={busy} onChange={event => void selectAlbum(event.target.value)}>{remote.albums.map(album => <option key={album.id} value={album.id}>{album.title}</option>)}</select><div className="shared-toolbar-actions"><button className="text-button" aria-pressed={comparisonMode} disabled={busy} onClick={() => { if (comparisonMode) clearComparison(); else void loadCandidates(); }}>비교</button><button className="icon-button" aria-label="새로고침" disabled={busy} onClick={() => void selectAlbum(remote.album!.id)}><Icon name="retry" /></button><button className="text-button" aria-label="초대 링크 만들기" disabled={busy} onClick={() => void invite()}>초대</button><button className="text-button" disabled={busy} onClick={openManager}>보관함 관리</button><button className="text-button" disabled={busy} onClick={() => { sourceEpoch.current += 1; setRemote(previous => previous ? { ...previous, album: null, members: [] } : null); setPhotos([]); clearTransient(); }}>보관함</button></div></> : <><select aria-label="미리보기 사용자" value={localMember} disabled={busy} onChange={event => { setLocalMember(event.target.value); setDownloadIds(null); }}>{MEMBERS.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select><button className="text-button" disabled={busy || photos.length > 0} onClick={() => void mutate(seedDemo)}>샘플</button></>}</div>
        {!managerOpen && !downloadIds && errorControl()}
        {queuedFiles.length > 0 && <section className="upload-queue" aria-label="업로드 파일"><div className="queue-progress">{progress && <><progress value={progress.done} max={progress.total} aria-label="업로드" /><output>{progress.done}/{progress.total}</output></>}</div>{queuedFiles.map((file, index) => <div className="queue-item" key={`${index}:${file.name}`}><Icon name={error ? 'alert' : 'image'} /><span>{file.name}</span><span>{formatBytes(file.size)}</span>{!busy && <button className="icon-button" aria-label={`${file.name} 대기열에서 제거`} onClick={() => { setQueuedFiles(current => current.filter((_, i) => i !== index)); }}><Icon name="close" /></button>}</div>)}{!busy && <button className="button secondary" disabled={!queuedValid} onClick={() => void upload(queuedFiles)}>올리기</button>}</section>}
        <section className="library" aria-label="사진 보관함"><div className="library-top"><span>{photos.length}</span><button className="text-button" disabled={!pendingPhotos.length || busy} onClick={() => setDownloadIds(pendingPhotos.map(p => p.id))}><Icon name="download" size={16} />다운로드 기록 {pendingPhotos.length > 0 && <span>{pendingPhotos.length}</span>}</button></div>
          <div className="filter-row"><div className="filter-chips" aria-label="사진 필터">{FILTERS.map(filter => <button key={filter.id} className={`filter-chip ${filters.includes(filter.id) ? 'active' : ''}`} aria-label={filter.label} aria-pressed={filters.includes(filter.id)} onClick={() => toggleFilter(filter.id)}>{({ all: '전체', others: '내 사진 제외', mine: '내 사진', unreceived: '받은 사진 제외', duplicates: '중복' })[filter.id]}{filter.id === 'duplicates' && duplicateCount > 0 && <span>{duplicateCount}</span>}</button>)}</div></div>
          <div className="selection-row"><label className="select-all"><input type="checkbox" aria-label="현재 사진 전체 선택" checked={visible.length > 0 && visible.every(p => selected.has(p.id))} disabled={!visible.length || busy} onChange={event => setSelected(event.target.checked ? new Set(visible.map(p => p.id)) : new Set())} />전체 선택</label><div className="selection-tools"><span>{visible.length}</span><button className="text-button" aria-label="사진 선택" aria-pressed={selectionMode} disabled={busy || !visible.length} onClick={() => setSelectionMode(value => !value)}>{selectionMode ? '완료' : '선택'}</button><div className="grid-zoom"><button className="icon-button" aria-label="사진 확대" disabled={busy || columns <= 2} onClick={() => setColumns(value => Math.max(2, value - 1))}><Icon name="plus" size={16} /></button><output aria-label="한 줄 사진 수">{columns}</output><button className="icon-button" aria-label="사진 축소" disabled={busy || columns >= maxColumns} onClick={() => setColumns(value => Math.min(maxColumns, value + 1))}><Icon name="minus" size={16} /></button></div></div></div>
          {!comparisonMode && remote?.album && (candidatesLoading ? <div role="status" aria-label="중복 후보 불러오는 중"><span className="loading-dot" /></div> : candidatesError ? <div className="failure-controls" role="group" aria-label="중복 후보 불러오기 실패"><Icon name="alert" /><span className="visually-hidden" role="alert">{candidatesError}</span><button className="icon-button" aria-label="재시도" disabled={busy} onClick={() => void loadCandidates(false)}><Icon name="retry" /></button></div> : null)}
          {comparisonMode && remote?.album ? <section className="similar-board" aria-label="비교 후보" aria-busy={candidatesLoading}>
            <header className="similar-board-header"><h2>비교</h2><div className="candidate-counts"><output aria-label="비교 후보 수">{candidates ? candidateGroups.length : '—'}</output>{candidates && <><span role="img" aria-label={`분석 완료 ${candidates.analyzed}`}><Icon name="check" size={16} />{candidates.analyzed}</span>{candidates.pending > 0 && <span role="img" aria-label={`분석 대기 ${candidates.pending}`}><Icon name="clock" size={16} />{candidates.pending}</span>}{candidates.failed > 0 && <span role="img" aria-label={`분석 실패 ${candidates.failed}`}><Icon name="alert" size={16} />{candidates.failed}</span>}</>}<button className="icon-button" aria-label="후보 새로고침" disabled={busy || candidatesLoading} onClick={() => void loadCandidates()}><Icon name="retry" /></button></div></header>
            {candidatesLoading ? <div className="empty-state" role="status" aria-label="비교 후보 불러오는 중"><span className="loading-dot" /></div> : candidatesError ? <div className="failure-controls" role="group" aria-label="비교 후보 불러오기 실패"><Icon name="alert" /><span className="visually-hidden" role="alert">{candidatesError}</span><button className="icon-button" aria-label="재시도" disabled={busy} onClick={() => void loadCandidates()}><Icon name="retry" /></button></div> : candidateGroups.length > 0 ? <div className="candidate-grid">{candidateGroups.map((group, index) => <button className="candidate-group" key={group.id} aria-label={`비교 후보 ${index + 1} 열기`} onClick={() => { setComparisonPage(0); setComparisonGroupId(group.id); }}><div className="candidate-previews">{group.photos.slice(0, 4).map(photo => <div key={photo.id}><Preview photo={photo} thumbnailOnly /></div>)}</div><span><Icon name="layers" size={16} /><output>{group.photos.length}</output></span></button>)}</div> : <div className="empty-state"><Icon name="layers" size={48} />{candidates && <output>0</output>}{candidates && candidates.groups.length > 0 && <button className="button secondary" onClick={() => setFilters(['all'])}>필터 초기화</button>}</div>}
          </section> : loading ? <div className="empty-state" aria-label="보관함 불러오는 중"><span className="loading-dot" /></div> : photos.length === 0 ? <div className="empty-state"><Icon name="image" size={56} /><button className="button primary" aria-label="첫 사진 올리기" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="plus" />올리기</button></div> : !visible.length ? <div className="empty-state"><Icon name="image" size={48} /><button className="button secondary" onClick={() => setFilters(['all'])}>필터 초기화</button></div> : <PhotoGrid ids={visibleIds} selected={selected} onSelectionChange={setSelected} selectionMode={selectionMode} disabled={busy || loading || !!viewerId || !!comparisonGroupId || managerOpen || needsNickname || !!downloadIds} columns={columns} maxColumns={maxColumns} onColumnsChange={setColumns}>{visible.map(photo => <PhotoCard key={photo.id} photo={photo} member={member} members={members} selectionMode={selectionMode} selected={selected.has(photo.id)} onSelect={() => selectPhoto(photo.id)} onView={() => { if (selectionMode) { selectPhoto(photo.id); return; } const stack = stacks.find(value => value.representative.id === photo.id); if (stack && stack.photos.length > 1) { setComparisonPage(0); setComparisonGroupId(stack.id); } else setViewerId(photo.id); }} stackCount={stacks.find(stack => stack.representative.id === photo.id)?.photos.length} stackPhotos={stacks.find(stack => stack.representative.id === photo.id)?.photos} busy={busy} onRetry={kind => void retryPhotoProcessing(photo, kind)} />)}<button className="add-card" aria-label="사진 더 올리기" disabled={busy} onClick={() => fileInput.current?.click()}><Icon name="plus" size={32} /></button></PhotoGrid>}
        </section>
      </>}
    </main>
    {needsNickname && <Modal label="닉네임 설정" onClose={() => {}} className="download-dialog"><header className="dialog-header"><h2>닉네임</h2></header>{errorControl()}<form className="member-name-form" onSubmit={event => { event.preventDefault(); void saveNickname(); }}><label htmlFor="member-nickname">닉네임<input id="member-nickname" aria-label="닉네임" value={nickname} onChange={event => setNickname(event.target.value)} maxLength={24} required disabled={busy} autoComplete="nickname" autoFocus /></label><button className="button primary" disabled={busy || !nickname.trim()}>완료</button></form></Modal>}
    <input ref={fileInput} className="visually-hidden" type="file" multiple accept="image/jpeg,image/png,image/webp,image/heic,image/heif,image/avif,image/gif,.heic,.heif" aria-label="사진 파일 선택" onChange={onFiles} />
    {selectedPhotos.length > 0 && (localMode || remote?.album) && <aside className="download-tray" aria-label="선택한 사진"><div className="tray-count"><span>{selectedPhotos.length}</span><small>{formatBytes(selectedPhotos.reduce((sum, photo) => sum + photo.size, 0))}</small></div><div className="tray-actions"><button className="text-button" onClick={() => setSelected(new Set())}>선택 해제</button><button className="button primary" onClick={() => setDownloadIds(selectedPhotos.map(photo => photo.id))} disabled={busy || !downloadReady}><Icon name="download" />선택 다운로드</button></div></aside>}
    {dragging && <div className="drop-overlay" aria-label="사진 업로드" onDragOver={event => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={drop}><Icon name="plus" size={64} /></div>}
    {comparisonGroupId && comparisonPhotos.length >= 2 && !viewerId && <Comparison key={comparisonGroupId} photos={comparisonPhotos} initialPage={comparisonPage} representativeId={stacks.find(stack => stack.id === comparisonGroupId)?.representative.id} onRepresentative={id => void chooseRepresentative(id)} failure={error ? <div className="failure-controls" role="group" aria-label="대표사진 변경 실패"><Icon name="alert" /><span className="visually-hidden" role="alert">{error}</span>{representativeRetryId.current && <button className="icon-button" aria-label="재시도" disabled={busy} onClick={() => void chooseRepresentative(representativeRetryId.current!)}><Icon name="retry" /></button>}<button className="icon-button" aria-label="오류 닫기" onClick={() => setError('')}><Icon name="close" /></button></div> : null} selected={selected} selectedCount={selectedPhotos.length} busy={busy} onSelect={id => selectPhoto(representativeDownloadIds([id], stacks)[0] ?? id)} onClose={() => setComparisonGroupId(null)} onView={(id, page) => { setComparisonPage(page); returnComparisonId.current = comparisonGroupId; setComparisonGroupId(null); setViewerId(id); }} onDownload={() => { setComparisonGroupId(null); returnComparisonId.current = null; setDownloadIds(selectedPhotos.map(photo => photo.id)); }} />}
    {viewerId && visible.length > 0 && <Viewer photos={returnComparisonId.current ? stacks.find(stack => stack.id === returnComparisonId.current)?.photos ?? photos.filter(photo => photo.id === viewerId) : visible} initialId={viewerId} onClose={() => { setViewerId(null); if (returnComparisonId.current) { setComparisonGroupId(returnComparisonId.current); returnComparisonId.current = null; } }} onDownload={id => { setViewerId(null); returnComparisonId.current = null; setDownloadIds(representativeDownloadIds([id], stacks)); }} onNotice={setNotice} />}
    {downloadIds && <Modal label="선택 사진 다운로드" onClose={() => { if (!busy) setDownloadIds(null); }} className="download-dialog"><header className="dialog-header"><h2>다운로드</h2><button className="icon-button" disabled={busy} aria-label="다운로드 창 닫기" onClick={() => setDownloadIds(null)}><Icon name="close" /></button></header>
      {errorControl()}<button className="button primary batch-download" disabled={busy || !downloadReady || !normalizedDownloadIds?.length || (normalizedDownloadIds.length > 1 && downloadSize > MAX_ARCHIVE_BYTES)} onClick={() => void downloadBatch()}><Icon name="download" />일괄 다운로드 <span>{normalizedDownloadIds?.length}</span></button><div className="download-capacity"><span>{formatBytes(downloadSize)}</span>{(normalizedDownloadIds?.length ?? 0) > 1 && <span>/ {formatBytes(MAX_ARCHIVE_BYTES)}</span>}</div>
      {busy && progress && <div className="queue-progress"><progress value={progress.done} max={progress.total} aria-label="다운로드 진행" /><output>{progress.done}/{progress.total}</output></div>}
      <div className="download-list">{(normalizedDownloadIds ?? []).map(id => photos.find(photo => photo.id === id)).filter((photo): photo is Photo => !!photo).map(photo => <div key={photo.id} className="download-item"><div className="download-thumb"><Preview photo={photo} /></div><div className="download-item-info"><strong>{photo.name}</strong><small>{formatBytes(photo.size)}</small><span role="img" aria-label={photo.receivedBy.includes(member) ? '받았음 확인' : photo.requestedBy.includes(member) ? '다운로드 요청됨' : '아직 요청하지 않음'}><Icon name={photo.receivedBy.includes(member) ? 'check' : photo.requestedBy.includes(member) ? 'download' : 'image'} size={16} /></span></div><button className="icon-button" aria-label={`${photo.name} 다운로드 선택 해제`} disabled={busy} onClick={() => setDownloadIds(current => current?.filter(id => representativeDownloadIds([id], stacks)[0] !== photo.id) ?? null)}><Icon name="close" /></button><div className="receipt-actions">{photo.requestedBy.includes(member) && <><button className="icon-button" disabled={busy} aria-label="받았음 확인" aria-pressed={photo.receivedBy.includes(member)} onClick={() => void mutate(() => downloadState([photo.id], photo.receivedBy.includes(member) ? 'reset' : 'received'))}><Icon name="check" /></button><button className="icon-button" disabled={busy} aria-label="기록 되돌리기" onClick={() => void mutate(() => downloadState([photo.id], 'reset'))}><Icon name="retry" /></button></>}</div><button className="icon-button outlined" disabled={busy || !downloadReady} aria-label={`${photo.name} 원본 다운로드`} onClick={() => void download(photo)}><Icon name="download" /></button></div>)}</div></Modal>}
    {managerOpen && <Modal label="공유보관함 관리" onClose={dismissManager} className="download-dialog shared-dialog"><header className="dialog-header"><h2>{incomingInvite ? '참여' : '보관함'}</h2><button className="icon-button" disabled={busy} aria-label="공유보관함 관리 닫기" onClick={dismissManager}><Icon name="close" /></button></header>
      {!incomingInvite && errorControl()}{!remote ? <div className="connect-actions">{incomingInvite && errorControl()}{approvalCode !== null && <section className="approval-pending" aria-label="계정 승인 대기"><Icon name="lock" size={40} /><output aria-label="계정 코드">{approvalCode}</output><button className="icon-button" disabled={busy || loading} aria-label="새로고침" onClick={() => void connectShared()}><Icon name="retry" /></button></section>}
        {googleButton()}<button className="button primary" disabled={busy || loading || !passkeySupported()} onClick={() => void connectShared(true)}>로그인</button><button className="button secondary" disabled={busy || loading} onClick={() => void connectShared()}>시작</button>
        {approvalCode !== null && <button className="button secondary" disabled={busy || !passkeySupported()} onClick={() => void mutate(async () => { await registerPasskey(); setPasskeyRegistered(true); return []; }, '패스키 등록 완료')}>{passkeyRegistered ? <Icon name="check" /> : <Icon name="lock" />}패스키 등록</button>}
        <button className="text-button" disabled={busy} onClick={() => void returnLocal()}>기기 보관함</button>
      </div> : incomingInvite ? <section aria-label="초대 참여" aria-busy={busy}>
        {inviteFailure ? <form className="shared-form" onSubmit={event => { event.preventDefault(); void joinSharedAlbum(); }}>
          <span role="img" aria-label={inviteFailure === 'invalid' ? '사용할 수 없는 초대' : inviteFailure === 'full' ? '보관함 인원 제한' : '초대 참여 실패'}><Icon name={inviteFailure === 'invalid' ? 'close' : inviteFailure === 'full' ? 'user' : 'alert'} size={40} /></span>
          <span className="visually-hidden" role="alert">{error}</span>
          <label htmlFor="incoming-token">초대 링크</label><input id="incoming-token" aria-label="초대 링크" value={inviteToken} maxLength={2048} required disabled={busy} onChange={event => setInviteToken(event.target.value)} />
          <button className="button primary" disabled={busy || !inviteToken.trim()}>{inviteFailure === 'invalid' ? '참여' : '재시도'}</button>
        </form> : <div className="empty-state" role="status" aria-label="보관함 참여 중"><span className="loading-dot" /></div>}
      </section> : <>
        <form className="shared-form" onSubmit={event => { event.preventDefault(); void createSharedAlbum(); }}><label htmlFor="album-name">보관함 이름</label><input id="album-name" aria-label="보관함 이름" value={albumTitle} maxLength={80} required onChange={event => setAlbumTitle(event.target.value)} disabled={busy} /><label htmlFor="owner-nickname">닉네임</label><div><input id="owner-nickname" aria-label="닉네임" value={ownerNickname} maxLength={24} required autoComplete="nickname" onChange={event => setOwnerNickname(event.target.value)} disabled={busy} /><button className="button primary" disabled={busy || !albumTitle.trim() || !ownerNickname.trim()}>만들기</button></div></form>
        <form className="shared-form" onSubmit={event => { event.preventDefault(); void joinSharedAlbum(); }}><label htmlFor="invite-token">초대 코드</label><input id="invite-token" aria-label="초대 코드" value={inviteToken} onChange={event => setInviteToken(event.target.value)} maxLength={2048} required disabled={busy} aria-invalid={!!error && !!inviteToken} /><button className="button secondary" disabled={busy || !inviteToken.trim()}>참여</button></form>
        {inviteLink && <div className="shared-form"><label htmlFor="share-link">초대 링크</label><input id="share-link" aria-label="초대 링크" value={inviteLink} readOnly onFocus={event => event.target.select()} /><time>{new Date(inviteExpires).toLocaleString('ko-KR')}</time><button className="button secondary" aria-label="초대 링크 복사" onClick={async () => { try { await navigator.clipboard.writeText(inviteLink); setCopied(true); } catch { setCopied(false); document.getElementById('share-link')?.focus(); } }}><Icon name={copied ? 'check' : 'copy'} />복사</button></div>}
        {remote.album && <form className="member-name-form" onSubmit={event => { event.preventDefault(); void saveNickname(); }}><label htmlFor="own-nickname">내 닉네임<input id="own-nickname" aria-label="내 닉네임" value={nickname} maxLength={24} required disabled={busy} onChange={event => setNickname(event.target.value)} /></label><button className="button secondary" disabled={busy || !nickname.trim()}>저장</button></form>}
        <div className="shared-form">{googleButton(true)}<button className="button secondary" disabled={busy || !passkeySupported()} onClick={() => void mutate(async () => { await registerPasskey(); setPasskeyRegistered(true); return photos; }, '패스키 등록 완료')}>{passkeyRegistered ? <Icon name="check" /> : <Icon name="lock" />}패스키 등록</button><button className="text-button" disabled={busy} onClick={() => void returnLocal()}>기기 보관함</button></div>
      </>}
    </Modal>}
  </div></ApprovalContext.Provider>;
}
