'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

declare global {
  interface Window {
    __CS_API_BASE_URL__?: string;
    __CS_REVIEW_ENABLED__?: boolean;
  }
}

type CaseStatus = 'unanswered' | 'ai-ready' | 'review' | 'no-reply' | 'replied' | 'closed';
type RawRow = Record<string, unknown>;
type Message = { actor: 'customer' | 'seller'; time: string; text: string; image?: boolean };
type SourceUrlKind = 'EXACT' | 'LIST' | 'UNAVAILABLE';
type SourceGuide = { url: string; reference: string; product: string };
type CsCase = {
  id: string;
  channel: string;
  surface: 'chat' | 'post';
  customer: string;
  category: string;
  product: string;
  preview: string;
  updatedAt: string;
  updatedRaw: string;
  status: CaseStatus;
  sourceUrl: string;
  sourceUrlKind: SourceUrlKind;
  sourceReference: string;
  productUrl: string;
  productId: string;
  productThumbnailUrl: string;
  imageCount: number;
  bodyCollected: boolean;
  alert?: string;
  postTitle?: string;
  messages: Message[];
  draftId?: string;
  ai?: { text: string; reason: string; generatedAt: string; risk: '낮음' | '중간' | '높음'; mode: 'reply' | 'eval' };
  humanRevision?: { text: string; state: string; reviewedAt: string };
  actualReply?: { text: string; sentAt: string; verifiedAt: string };
};
type Overview = { total_live: number; needs_reply: number; answered: number; review: number; no_reply_required: number; ai_ready: number; closed: number };
type EnvironmentName = 'development' | 'production' | 'unconfigured';

const EMPTY_OVERVIEW: Overview = { total_live: 0, needs_reply: 0, answered: 0, review: 0, no_reply_required: 0, ai_ready: 0, closed: 0 };
const statusMeta: Record<CaseStatus, { label: string; shortLabel: string; tone: string; dot: string }> = {
  unanswered: { label: '미응답', shortLabel: '미응답', tone: 'status-red', dot: '#e24b4b' },
  'ai-ready': { label: 'AI 답변 준비', shortLabel: 'AI 준비', tone: 'status-purple', dot: '#7257d7' },
  review: { label: '검토 필요', shortLabel: '검토', tone: 'status-amber', dot: '#d88b1f' },
  'no-reply': { label: '답변 불필요', shortLabel: '불필요', tone: 'status-blue', dot: '#3677d2' },
  replied: { label: '답변 완료', shortLabel: '완료', tone: 'status-green', dot: '#2f9b68' },
  closed: { label: '처리 종료', shortLabel: '종료', tone: 'status-gray', dot: '#7c8799' },
};
const filters: Array<{ key: 'all' | CaseStatus; label: string }> = [
  { key: 'all', label: '전체' }, { key: 'unanswered', label: '미응답' }, { key: 'ai-ready', label: 'AI 답변 준비' },
  { key: 'review', label: '검토 필요' }, { key: 'no-reply', label: '답변 불필요' }, { key: 'replied', label: '답변 완료' },
  { key: 'closed', label: '처리 종료' },
];

function text(value: unknown, fallback = '') { const result = String(value ?? '').trim(); return result || fallback; }
function bool(value: unknown) { return value === true || value === 1 || ['TRUE', '1', 'Y', 'YES'].includes(text(value).toUpperCase()); }
function formatDate(value: unknown) {
  const raw = text(value); if (!raw) return '시각 미수집';
  const date = new Date(raw); if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat('ko-KR', { month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(date);
}
function marketLabel(value: unknown) {
  const market = text(value).toUpperCase();
  if (market === 'SMARTSTORE') return '스마트스토어';
  if (market === 'ZIGZAG' || market === 'KAKAOSTYLE') return '지그재그';
  if (market === 'ABLY') return '에이블리';
  return text(value, '마켓 미수집');
}
function caseStatus(row: RawRow): CaseStatus {
  if (text(row.ai_draft_state).toUpperCase() === 'READY') return 'ai-ready';
  const state = text(row.reply_state).toUpperCase();
  if (state === 'NEEDS_REPLY') return 'unanswered';
  if (state === 'REVIEW') return 'review';
  if (state === 'NO_REPLY_REQUIRED') return 'no-reply';
  if (state === 'CLOSED') return 'closed';
  return 'replied';
}
function draftReason(value: unknown) {
  const raw = text(value, '추천 근거가 별도로 기록되지 않았습니다.');
  try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed.join(' · ') : raw; } catch { return raw; }
}
function riskLevel(value: unknown): '낮음' | '중간' | '높음' {
  const scan = text(value).toUpperCase();
  if (scan.includes('FAIL') || scan.includes('HIGH')) return '높음';
  if (scan.includes('WARN') || scan.includes('CHECK')) return '중간';
  return '낮음';
}
function baseCase(row: RawRow): CsCase {
  const status = caseStatus(row); const scan = text(row.pii_scan).toUpperCase(); const rawPreview = text(row.preview);
  const sourceUrl = text(row.source_url); const rawSourceUrlKind = text(row.source_url_kind).toUpperCase();
  const sourceUrlKind: SourceUrlKind = rawSourceUrlKind === 'EXACT' || rawSourceUrlKind === 'LIST' || rawSourceUrlKind === 'UNAVAILABLE'
    ? rawSourceUrlKind : (sourceUrl ? 'LIST' : 'UNAVAILABLE');
  return {
    id: text(row.case_key, 'CASE_KEY_MISSING'), channel: `${marketLabel(row.market)} · ${text(row.channel, '문의')}`,
    surface: text(row.ui_type).toUpperCase() === 'CHAT' ? 'chat' : 'post', customer: text(row.customer_masked, '고객정보 마스킹'),
    category: text(row.category, '미분류'), product: text(row.product_name, text(row.subject, '상품정보 미수집')),
    preview: rawPreview || '과거 이관 데이터 · 문의 본문 미수집', updatedAt: formatDate(row.last_changed_at ?? row.last_seen_at ?? row.last_message_at),
    updatedRaw: text(row.last_seen_at ?? row.last_changed_at ?? row.last_message_at), status, sourceUrl, sourceUrlKind,
    sourceReference: text(row.source_reference), productUrl: text(row.product_url), productId: text(row.product_id),
    productThumbnailUrl: text(row.product_thumbnail_url), imageCount: Math.max(0, Number(row.image_count ?? 0) || 0), bodyCollected: Boolean(rawPreview),
    alert: status === 'review' ? '수집 상태 또는 답변 여부 확인 필요' : (scan.includes('WARN') || scan.includes('FAIL') ? `개인정보 검사 ${text(row.pii_scan)}` : undefined),
    postTitle: text(row.subject, text(row.category, '문의 내용')), messages: [],
    actualReply: bool(row.human_reply_exists) ? { text: text(row.latest_human_reply_preview, '답변 존재 · 본문 미수집'), sentAt: formatDate(row.human_reply_at), verifiedAt: formatDate(row.last_seen_at) } : undefined,
  };
}
function hydrateCase(row: RawRow, messageRows: RawRow[], draftRows: RawRow[]): CsCase {
  const item = baseCase(row);
  item.messages = messageRows.map((message): Message | null => {
    const body = text(message.message_text_masked); if (!body) return null;
    const actorRaw = text(message.actor_type).toUpperCase();
    return { actor: actorRaw.includes('SELLER') || actorRaw.includes('ADMIN') ? 'seller' : 'customer', time: formatDate(message.message_at), text: body, image: Number(message.image_count ?? 0) > 0 };
  }).filter((message): message is Message => message !== null);
  item.imageCount = Math.max(item.imageCount, messageRows.reduce((total, message) => total + Math.max(0, Number(message.image_count ?? 0) || 0), 0));
  if (!item.messages.length && item.bodyCollected) item.messages.push({ actor: 'customer', time: item.updatedAt, text: item.preview });
  if (item.actualReply && !item.messages.some((message) => message.actor === 'seller')) item.messages.push({ actor: 'seller', time: item.actualReply.sentAt, text: item.actualReply.text });
  const draft = draftRows.find((row) => ['READY', 'APPROVED', 'EVAL'].includes(text(row.draft_state).toUpperCase()));
  if (draft && text(draft.draft_text)) {
    const draftState = text(draft.draft_state).toUpperCase();
    item.draftId = text(draft.draft_id);
    item.ai = { text: text(draft.draft_text), reason: draftReason(draft.required_checks), generatedAt: formatDate(draft.generated_at), risk: riskLevel(draft.pii_scan), mode: draftState === 'EVAL' ? 'eval' : 'reply' };
  }
  const reviewedDraft = draftRows.find((row) => text(row.human_revision));
  if (reviewedDraft) item.humanRevision = { text: text(reviewedDraft.human_revision), state: text(reviewedDraft.draft_state, '검토됨'), reviewedAt: formatDate(reviewedDraft.reviewed_at) };
  return item;
}
function statusQuery(filter: 'all' | CaseStatus) {
  if (filter === 'all') return '';
  if (filter === 'ai-ready') return '&ai_draft_state=READY';
  const state = { unanswered: 'NEEDS_REPLY', review: 'REVIEW', 'no-reply': 'NO_REPLY_REQUIRED', replied: 'ANSWERED', closed: 'CLOSED' }[filter];
  return state ? `&reply_state=${state}` : '';
}

function sortCasesRecent(items: CsCase[]) {
  return [...items].sort((a, b) => {
    const aTime = Date.parse(a.updatedRaw || '');
    const bTime = Date.parse(b.updatedRaw || '');
    return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
  });
}
function apiPath(path: string) {
  const publicApi = typeof window === 'undefined' ? '' : text(window.__CS_API_BASE_URL__);
  if (!publicApi || !path.startsWith('/api/cs')) return path;
  return `${publicApi}${path.slice('/api/cs'.length)}`;
}
async function getJson(path: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const response = await fetch(apiPath(path), { cache: 'default', signal }); const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload?.ok) throw new Error(text(payload?.error, 'DATA_LOAD_FAILED')); return payload;
}
async function postJson(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await fetch(apiPath(path), { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok || !payload?.ok) throw new Error(text(payload?.error, 'REVIEW_SAVE_FAILED'));
  return payload;
}

export default function Home() {
  const [activeFilter, setActiveFilter] = useState<'all' | CaseStatus>('all');
  const [cases, setCases] = useState<CsCase[]>([]); const [selectedId, setSelectedId] = useState('');
  const [selectedDetail, setSelectedDetail] = useState<CsCase | null>(null); const [overview, setOverview] = useState<Overview>(EMPTY_OVERVIEW);
  const [environment, setEnvironment] = useState<EnvironmentName>('unconfigured');
  const [search, setSearch] = useState(''); const [editor, setEditor] = useState(''); const [toast, setToast] = useState('');
  const [sourceGuide, setSourceGuide] = useState<SourceGuide | null>(null);
  const [reviewSaving, setReviewSaving] = useState(false);
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false); const [detailLoading, setDetailLoading] = useState(false); const [error, setError] = useState('');
  const listRequestId = useRef(0); const detailRequestId = useRef(0);

  const setOverviewPayload = (payload: Record<string, unknown>) => {
    setEnvironment(['development', 'production'].includes(text(payload.environment)) ? text(payload.environment) as EnvironmentName : 'unconfigured');
    setOverview({
      total_live: Number(payload.total_live ?? 0), needs_reply: Number(payload.needs_reply ?? 0), answered: Number(payload.answered ?? 0),
      review: Number(payload.review ?? 0), no_reply_required: Number(payload.no_reply_required ?? 0), ai_ready: Number(payload.ai_ready ?? 0), closed: Number(payload.closed ?? 0),
    });
  };
  const fetchCases = useCallback(async (filter: 'all' | CaseStatus, limit: number, cursor: number, signal?: AbortSignal, fresh = false) => {
    const payload = await getJson(`/api/cs?action=cases&limit=${limit}&cursor=${cursor}${statusQuery(filter)}${fresh ? '&fresh=1' : ''}`, signal);
    return { items: (payload.items as RawRow[]).map(baseCase), total: Number(payload.total ?? 0) };
  }, []);
  const refresh = useCallback(async () => {
    const requestId = ++listRequestId.current; setLoading(true); setLoadingMore(false); setError('');
    try {
      const first = await fetchCases(activeFilter, 3, 0, undefined, true);
      if (requestId !== listRequestId.current) return;
      setCases(first.items); setEditor(''); setDetailLoading(first.items.length > 0); setLoading(false); setLoadingMore(first.total > first.items.length);
      setSelectedId((current) => first.items.some((item) => item.id === current) ? current : (first.items[0]?.id ?? ''));
      const [overviewPayload, rest] = await Promise.all([
        getJson('/api/cs?action=overview&fresh=1'),
        first.total > first.items.length ? fetchCases(activeFilter, 197, 3, undefined, true) : Promise.resolve({ items: [], total: first.total }),
      ]);
      if (requestId !== listRequestId.current) return;
      setOverviewPayload(overviewPayload); setCases(sortCasesRecent([...first.items, ...rest.items])); setLoadingMore(false);
    } catch (cause) {
      if (requestId === listRequestId.current) setError(cause instanceof Error ? cause.message : 'DATA_LOAD_FAILED');
    } finally {
      if (requestId === listRequestId.current) { setLoading(false); setLoadingMore(false); }
    }
  }, [activeFilter, fetchCases]);

  useEffect(() => {
    const controller = new AbortController(); const requestId = ++listRequestId.current;
    fetchCases(activeFilter, 3, 0, controller.signal)
      .then(async (first) => {
        if (requestId !== listRequestId.current) return;
        setCases(first.items); setEditor(''); setDetailLoading(first.items.length > 0); setLoading(false); setLoadingMore(first.total > first.items.length);
        setSelectedId((current) => first.items.some((item) => item.id === current) ? current : (first.items[0]?.id ?? ''));
        const [payload, rest] = await Promise.all([
          getJson('/api/cs?action=overview', controller.signal),
          first.total > first.items.length ? fetchCases(activeFilter, 197, 3, controller.signal) : Promise.resolve({ items: [], total: first.total }),
        ]);
        if (requestId !== listRequestId.current) return;
        setOverviewPayload(payload); setCases(sortCasesRecent([...first.items, ...rest.items])); setLoadingMore(false);
      }).catch((cause) => {
        if (requestId === listRequestId.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'DATA_LOAD_FAILED');
      }).finally(() => { if (requestId === listRequestId.current) { setLoading(false); setLoadingMore(false); } });
    return () => controller.abort();
  }, [activeFilter, fetchCases]);
  useEffect(() => {
    const requestId = ++detailRequestId.current; if (!selectedId) return;
    const controller = new AbortController();
    getJson(`/api/cs?action=case&case_key=${encodeURIComponent(selectedId)}`, controller.signal)
      .then((payload) => { if (requestId === detailRequestId.current) { const hydrated = hydrateCase(payload.case as RawRow, (payload.messages ?? []) as RawRow[], (payload.drafts ?? []) as RawRow[]); setSelectedDetail(hydrated); setEditor(hydrated.humanRevision?.text ?? ''); } })
      .catch((cause) => { if (requestId === detailRequestId.current && !(cause instanceof DOMException && cause.name === 'AbortError')) setError(cause instanceof Error ? cause.message : 'DETAIL_LOAD_FAILED'); })
      .finally(() => { if (requestId === detailRequestId.current) setDetailLoading(false); });
    return () => controller.abort();
  }, [selectedId]);

  const filteredCases = useMemo(() => {
    const term = search.trim().toLowerCase(); if (!term) return cases;
    return cases.filter((item) => [item.customer, item.product, item.preview, item.category, item.channel].join(' ').toLowerCase().includes(term));
  }, [cases, search]);
  const selected = selectedDetail?.id === selectedId ? selectedDetail : cases.find((item) => item.id === selectedId) ?? null;
  const customerMessages = selected?.messages.filter((message) => message.actor === 'customer') ?? [];
  const sellerMessages = selected?.messages.filter((message) => message.actor === 'seller') ?? [];
  const syncAt = cases.map((item) => item.updatedRaw).filter(Boolean).sort().at(-1);
  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(''), 2200); };
  const copyText = async (value: string) => { try { await navigator.clipboard.writeText(value); notify('클립보드에 복사했습니다.'); } catch { notify('브라우저에서 복사를 허용해 주세요.'); } };
  const openExternal = (url: string, label: string) => {
    const link = document.createElement('a');
    link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
    document.body.appendChild(link); link.click(); link.remove();
    notify(`${label}을 새 탭에서 열었습니다. 열리지 않으면 주소 복사를 사용해 주세요.`);
  };
  useEffect(() => {
    if (!sourceGuide) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSourceGuide(null); };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [sourceGuide]);
  const selectFilter = (filter: 'all' | CaseStatus) => {
    if (filter === activeFilter) return;
    listRequestId.current += 1; detailRequestId.current += 1; setLoading(true); setLoadingMore(false); setError(''); setCases([]); setSelectedId(''); setSelectedDetail(null); setActiveFilter(filter);
  };
  const selectCase = (id: string) => { if (id === selectedId) return; detailRequestId.current += 1; setEditor(''); setDetailLoading(true); setSelectedId(id); };
  const countFor = (status: CaseStatus) => ({ unanswered: overview.needs_reply, 'ai-ready': overview.ai_ready, review: overview.review, 'no-reply': overview.no_reply_required, replied: overview.answered, closed: overview.closed })[status];
  const localReviewEnabled = typeof window !== 'undefined' && !text(window.__CS_API_BASE_URL__) && window.__CS_REVIEW_ENABLED__ !== false && environment === 'development';
  const saveReview = async (draftState: 'APPROVED' | 'REJECTED') => {
    if (!selected?.draftId || selected.ai?.mode === 'eval' || !localReviewEnabled || reviewSaving) return;
    setReviewSaving(true); setError('');
    try {
      const revision = draftState === 'APPROVED' ? editor.trim() : '';
      await postJson('/api/cs', { draft_id: selected.draftId, draft_state: draftState, review_note: draftState === 'APPROVED' ? '개발 프론트에서 사람 검수 완료' : '개발 프론트에서 AI 초안 거절', human_revision: revision });
      setSelectedDetail({ ...selected, humanRevision: revision ? { text: revision, state: draftState, reviewedAt: formatDate(new Date().toISOString()) } : selected.humanRevision });
      notify(draftState === 'APPROVED' ? '사람 수정본을 개발 Sheet에 저장했습니다.' : 'AI 초안을 거절로 기록했습니다.');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'REVIEW_SAVE_FAILED');
    } finally {
      setReviewSaving(false);
    }
  };

  return <main className="app-shell">
    <aside className="nav-rail"><div className="brand-mark">PR</div><nav aria-label="주 메뉴"><button className="rail-button active"><span>◫</span><small>검수함</small></button><button className="rail-button"><span>⌁</span><small>통계</small></button><button className="rail-button"><span>⚙</span><small>설정</small></button></nav><div className="rail-footer">LIVE</div></aside>
    <section className="workspace">
      <header className="topbar"><div><div className="eyebrow">PINK ROCKET · CS REVIEW</div><h1>AI 답변 검수함</h1></div><div className="sync-area"><span className={`environment-badge ${environment}`}>{environment}</span><div className="sync-copy"><span className={`live-dot ${error ? 'error' : ''}`} /><strong>{error ? '연결 확인 필요' : `실데이터 ${overview.total_live.toLocaleString()}건`}</strong><small>{syncAt ? `최근 수집 기록 ${formatDate(syncAt)}` : '수집 기록 확인 중'}</small></div><button className="secondary-button" onClick={refresh} disabled={loading}>↻ {loading ? '불러오는 중' : '새로고침'}</button></div></header>
      {error && <div className="connection-error" role="alert"><strong>데이터를 불러오지 못했습니다.</strong><span>{error}</span><button onClick={refresh}>다시 시도</button></div>}
      <section className="status-strip" aria-label="문의 상태 요약">{filters.slice(1).map((filter) => { const meta = statusMeta[filter.key as CaseStatus]; return <button key={filter.key} className={`stat-card ${activeFilter === filter.key ? 'selected' : ''}`} onClick={() => selectFilter(filter.key as CaseStatus)}><span className="stat-dot" style={{ background: meta.dot }} /><span>{filter.label}</span><strong>{countFor(filter.key as CaseStatus).toLocaleString()}</strong></button>; })}</section>
      <div className="desk-grid">
        <section className="case-column" aria-label="문의 목록"><div className="case-toolbar"><label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="현재 목록에서 고객, 상품, 문의 검색" /></label><div className="filter-row" role="tablist">{filters.map((filter) => <button key={filter.key} className={activeFilter === filter.key ? 'active' : ''} onClick={() => selectFilter(filter.key)}>{filter.label}</button>)}</div><p className="list-scope">현재 조건 최신순 최대 {cases.length || 200}건 표시 {loadingMore ? '· 나머지 불러오는 중' : ''} · 민감정보 마스킹</p></div>
          <div className="case-list">{loading && !cases.length && <div className="empty-list loading-list"><span>⌁</span><strong>문의 목록을 불러오는 중입니다.</strong><p>구글시트 동기화 상태에 따라 약 5~15초 걸릴 수 있어요.</p></div>}{filteredCases.map((item) => { const meta = statusMeta[item.status]; return <button key={item.id} className={`case-item ${selected?.id === item.id ? 'active' : ''}`} onClick={() => selectCase(item.id)}><div className="case-item-top"><span className={`status-pill ${meta.tone}`}>{meta.shortLabel}</span><time>{item.updatedAt}</time></div><div className="case-title-row"><strong>{item.customer}</strong></div><p className="case-product">{item.product}</p><p className="case-preview">{item.preview}</p><div className="case-meta"><span className={`surface-tag ${item.surface}`}>{item.surface === 'chat' ? '● 채팅형' : '▤ 게시글형'}</span><span>{item.channel}</span><span>{item.category}</span></div></button>; })}{!loading && !filteredCases.length && <div className="empty-list">조건에 맞는 문의가 없습니다.</div>}</div>
        </section>
        <section className="conversation-column" aria-label="전체 대화">{!selected ? <div className="panel-empty"><span>⌁</span><strong>표시할 문의가 없습니다.</strong><p>상태 필터를 바꾸거나 데이터를 다시 불러와 주세요.</p></div> : <>
          <header className="case-header"><div className="case-header-copy"><div className="case-heading-line"><span className={`status-pill ${statusMeta[selected.status].tone}`}>{statusMeta[selected.status].label}</span><span className={`surface-label ${selected.surface}`}>{selected.surface === 'chat' ? '● 채팅형 문의' : '▤ 게시글형 문의'}</span><span className="case-id">{selected.id}</span></div><div className="case-product-heading">{selected.productThumbnailUrl && <img src={selected.productThumbnailUrl} alt="" referrerPolicy="no-referrer"/>}<div><h2>{selected.product}</h2><p>{selected.productId ? `상품 ID ${selected.productId} · ` : ''}{selected.channel} · 고객 {selected.customer}</p></div></div><div className="case-link-meta"><span>첨부 {selected.imageCount}개</span>{selected.sourceUrlKind === 'LIST' && <span>개별 원문 링크 아님</span>}</div></div><div className="case-header-actions">{selected.sourceUrlKind === 'EXACT' && <><button className="icon-button" disabled={!selected.sourceUrl} onClick={() => selected.sourceUrl && openExternal(selected.sourceUrl, '원문')}>원문 새 탭 ↗</button><button className="icon-button source-copy-button" disabled={!selected.sourceUrl} onClick={() => selected.sourceUrl && copyText(selected.sourceUrl)}>주소 복사</button></>}{selected.sourceUrlKind === 'LIST' && <button className="icon-button" disabled={!selected.sourceUrl} onClick={() => selected.sourceUrl && setSourceGuide({ url: selected.sourceUrl, reference: selected.sourceReference, product: selected.product })}>문의관리 안내</button>}{selected.sourceUrlKind === 'UNAVAILABLE' && <button className="icon-button" disabled>원문 미수집</button>}{selected.productUrl && <button className="icon-button product-link-button" onClick={() => openExternal(selected.productUrl, '상품 페이지')}>상품 보기 ↗</button>}</div></header>
          {selected.alert && <div className="warning-banner"><span>!</span><div><strong>사람 검토가 필요한 문의입니다.</strong><p>{selected.alert} · 자동 전송 금지</p></div></div>}{detailLoading && <div className="detail-loading">상세 메시지를 불러오는 중…</div>}
          {selected.surface === 'chat' ? <div className="conversation-scroll chat-surface"><div className="chat-notice">수집된 대화 · 시간순 메시지</div><div className="date-divider"><span>최근 대화</span></div>{selected.messages.length ? selected.messages.map((message, index) => <div key={`${selected.id}-${index}`} className={`message-row ${message.actor}`}><div className="avatar">{message.actor === 'seller' ? 'P' : 'C'}</div><div className="message-wrap"><div className="message-label"><strong>{message.actor === 'seller' ? '판매자 실제 답변' : '고객'}</strong><time>{message.time}</time></div><div className="message-bubble">{message.image && <div className="image-placeholder">▧ 첨부 이미지 있음 · 원문에서 확인</div>}<p>{message.text}</p></div></div></div>) : detailLoading ? <div className="collection-gap loading"><span>…</span><strong>문의 내용을 불러오는 중입니다.</strong><p>잠시 후 이 영역에 자동으로 표시됩니다.</p></div> : <div className="collection-gap"><span>!</span><strong>수집된 문의 본문이 없습니다.</strong><p>원문 열기에서 쇼핑몰의 문의 내용을 확인해 주세요.</p></div>}</div>
          : <div className="post-scroll"><article className="post-card"><div className="post-card-label"><span>문의 게시글</span><span>공개여부 미수집</span></div><h3>{selected.postTitle ?? selected.category}</h3><dl className="post-meta-grid"><div><dt>작성자</dt><dd>{selected.customer}</dd></div><div><dt>등록 시각</dt><dd>{customerMessages[0]?.time ?? selected.updatedAt}</dd></div><div><dt>문의 유형</dt><dd>{selected.category}</dd></div><div><dt>상품</dt><dd>{selected.product}</dd></div></dl><div className="post-body">{customerMessages.length ? customerMessages.map((message, index) => <div key={`${selected.id}-post-${index}`}>{message.image && <div className="post-attachment">▧ 고객 첨부 이미지 있음 · 원문에서 확인</div>}<p>{message.text}</p></div>) : detailLoading ? <div className="collection-gap loading"><span>…</span><strong>문의 내용을 불러오는 중입니다.</strong><p>잠시 후 이 영역에 자동으로 표시됩니다.</p></div> : <div className="collection-gap"><span>!</span><strong>수집된 문의 본문이 없습니다.</strong><p>원문 열기에서 쇼핑몰의 문의 내용을 확인해 주세요.</p></div>}</div></article><section className="board-answer"><div className="board-answer-title"><div><span className="answer-icon">P</span><div><strong>판매자 답변</strong><small>쇼핑몰에서 수집된 실제 답변</small></div></div>{sellerMessages[0] && <time>{sellerMessages[0].time}</time>}</div>{sellerMessages.length ? <div className="board-answer-body">{sellerMessages.map((message, index) => <p key={`${selected.id}-answer-${index}`}>{message.text}</p>)}</div> : <div className="board-answer-empty">아직 수집된 판매자 답변이 없습니다.</div>}</section></div>}
          <footer className="source-footer"><span>🔒 고객정보 마스킹됨</span><span>{selected.surface === 'chat' ? '채팅형' : '게시글형'} · 읽기 전용 수집 기록</span><span>원본 확인 {selected.updatedAt}</span></footer></>}
        </section>
        <aside className="reply-column" aria-label="답변 검수">{!selected ? <div className="panel-empty"><strong>문의를 선택해 주세요.</strong></div> : <><div className="reply-scroll">
          <section className="reply-section ai-section"><div className="section-title"><div><span className="section-kicker ai">AI</span><h3>{selected.ai?.mode === 'eval' ? 'AI 검증 초안' : 'AI 추천답변'}</h3></div>{selected.ai && <span className={`risk risk-${selected.ai.risk}`}>위험도 {selected.ai.risk}</span>}</div><div className="not-sent-label">{selected.ai?.mode === 'eval' ? '답변 완료 후 생성된 학습·검증용 초안 · 실제 사람 답변과 비교' : '사람 답변과 구분 · 자동 전송되지 않은 참고 문장'}</div>{selected.ai ? <><div className="draft-card ai-draft">{selected.ai.text}</div><div className="ai-reason"><strong>{selected.ai.mode === 'eval' ? '검증 조건' : '필수 확인사항'}</strong><p>{selected.ai.reason}</p><small>{selected.ai.generatedAt} · {selected.ai.mode === 'eval' ? 'EVAL 섀도 초안' : '저장된 AI 초안'}</small></div><div className="button-row"><button className="secondary-button" onClick={() => copyText(selected.ai!.text)}>복사</button>{selected.ai.mode !== 'eval' && <button className="purple-button" onClick={() => setEditor(selected.ai!.text)}>수정란에 적용</button>}</div></> : <div className="empty-draft"><span>✦</span><strong>저장된 AI 추천답변이 없습니다.</strong><p>AI 초안이 생성되면 사람 답변과 분리되어 여기에 표시됩니다.</p></div>}</section>
          <section className="reply-section human-section"><div className="section-title"><div><span className="section-kicker human">사람</span><h3>{selected.ai?.mode === 'eval' ? '검증 메모' : '사람 수정본'}</h3></div><span className="draft-status">{selected.ai?.mode === 'eval' ? 'EVAL · 실제 답변과 비교' : (selected.humanRevision ? `${selected.humanRevision.state} · ${selected.humanRevision.reviewedAt}` : '브라우저 임시 입력')}</span></div><label className="editor-label" htmlFor="human-draft">{selected.ai?.mode === 'eval' ? '학습·검증용 초안은 실제 답변과 비교만 합니다.' : '쇼핑몰에 복사할 최종 문장을 확인하세요.'}</label><textarea id="human-draft" value={editor} onChange={(event) => setEditor(event.target.value)} disabled={selected.ai?.mode === 'eval'} placeholder={selected.ai?.mode === 'eval' ? '아래 실제 사람 답변과 AI 검증 초안을 비교해 주세요.' : 'AI 추천을 적용하거나 직접 답변을 작성하세요.'}/><div className="editor-footer"><span>{editor.length}자</span><div className="button-row"><button className="secondary-button" disabled={!selected.draftId || selected.ai?.mode === 'eval' || !localReviewEnabled || reviewSaving} onClick={() => saveReview('REJECTED')}>초안 거절</button><button className="primary-button" disabled={!selected.draftId || selected.ai?.mode === 'eval' || !localReviewEnabled || !editor.trim() || reviewSaving} onClick={() => saveReview('APPROVED')}>{reviewSaving ? '저장 중' : '검수 저장'}</button><button className="secondary-button" disabled={!editor.trim()} onClick={() => copyText(editor)}>답변 복사</button></div></div><p className="send-boundary">{selected.ai?.mode === 'eval' ? '학습·검증용 섀도 초안입니다. 운영 상태와 쇼핑몰 답변에는 영향을 주지 않습니다.' : (localReviewEnabled ? '개발 Sheet에 사람 검수본만 저장합니다. 쇼핑몰로는 전송하지 않습니다.' : '검수 저장은 로컬 development 화면에서만 사용할 수 있습니다. 쇼핑몰로는 전송하지 않습니다.')}</p></section>
          <section className={`reply-section actual-section ${selected.actualReply ? 'verified' : ''}`}><div className="section-title"><div><span className="section-kicker actual">실제</span><h3>쇼핑몰 실제 답변</h3></div>{selected.actualReply ? <span className="verified-label">✓ 확인 완료</span> : <span className="unverified-label">미확인</span>}</div>{selected.actualReply ? <><div className="draft-card actual-draft">{selected.actualReply.text}</div><div className="verification-meta"><span>답변 시각 {selected.actualReply.sentAt}</span><span>최근 수집 확인 {selected.actualReply.verifiedAt}</span></div></> : <div className="verification-empty"><span className="scan-icon">⌁</span><div><strong>판매자 답변이 아직 확인되지 않았습니다.</strong><p>다음 수집에서 쇼핑몰 메시지와 답변 상태를 다시 확인합니다.</p></div></div>}</section>
        </div><div className="reply-bottom-bar"><div><span className="reply-state-dot" style={{ background: statusMeta[selected.status].dot }}/><strong>{statusMeta[selected.status].label}</strong></div><button onClick={() => notify('이 버튼은 아직 수집 매크로를 실행하지 않습니다.')}>답변 재확인 준비중</button></div></>}</aside>
      </div>
    </section>{sourceGuide && <div className="source-guide-backdrop" role="presentation" onMouseDown={() => setSourceGuide(null)}><section className="source-guide-dialog" role="dialog" aria-modal="true" aria-labelledby="source-guide-title" aria-describedby="source-guide-description" onMouseDown={(event) => event.stopPropagation()}><div className="source-guide-heading"><div><span className="source-guide-kicker">원문 확인</span><h2 id="source-guide-title">개별 문의 링크가 아닙니다.</h2></div><button className="dialog-close" type="button" aria-label="안내 닫기" onClick={() => setSourceGuide(null)}>×</button></div><p id="source-guide-description">이 버튼은 해당 문의를 바로 여는 주소가 아니라 쇼핑몰 문의관리 목록으로 이동합니다. 목록에서 아래 참조값 또는 상품명으로 문의를 확인해 주세요.</p><dl className="source-guide-reference"><dt>상품</dt><dd>{sourceGuide.product}</dd>{sourceGuide.reference && <><dt>참조값</dt><dd><code>{sourceGuide.reference}</code><button className="copy-reference" type="button" onClick={() => copyText(sourceGuide.reference)}>복사</button></dd></>}</dl><div className="source-guide-actions"><button className="secondary-button" type="button" onClick={() => setSourceGuide(null)}>닫기</button><button className="primary-button" type="button" onClick={() => { setSourceGuide(null); openExternal(sourceGuide.url, '문의관리'); }}>문의관리 새 탭 ↗</button></div></section></div>}{toast && <div className="toast" role="status">{toast}</div>}
  </main>;
}
