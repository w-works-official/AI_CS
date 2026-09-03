import { NextRequest, NextResponse } from 'next/server.js';
import { assertSingletonReadParams, normalizeCaseBatchKeys, normalizeLibraryReviewRequest, normalizeReviewRequest, normalizeSyncRequest, normalizeTemplateRequest, normalizeTemplateStateRequest } from './policy.ts';

export const dynamic = 'force-dynamic';

const ALLOWED_ACTIONS = new Set(['health', 'overview', 'dashboard', 'cases', 'case', 'caseBatch']);
const ALLOWED_PARAMS = new Set(['action', 'case_key', 'case_keys', 'record_type', 'market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state', 'limit', 'cursor', 'fresh']);
const LOCAL_ONLY_PARAMS = new Set(['t']);
type CacheEntry = { expiresAt: number; payload: unknown };
const cacheScope = globalThis as typeof globalThis & { __pinkRocketCsCache?: Map<string, CacheEntry> };
const responseCache = cacheScope.__pinkRocketCsCache ?? new Map<string, CacheEntry>();
cacheScope.__pinkRocketCsCache = responseCache;
type WebEnvironment = 'development' | 'production';
type D1Payload = Record<string, unknown>;
const DEFAULT_D1_API_URL = 'https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs';

/** Existing Apps Script target remains POST-only until the shadow-write cutover. */
function appsScriptTarget() {
  const environment = process.env.AI_CS_WEB_ENVIRONMENT as WebEnvironment | undefined;
  if (!environment) {
    const endpoint = process.env.MARKETPLACE_CS_SYNC_URL;
    const apiKey = process.env.MARKETPLACE_CS_SYNC_KEY;
    if (!endpoint || !apiKey) throw new Error('CS_DATA_CONNECTION_NOT_CONFIGURED');
    return { environment: 'development' as const, endpoint, apiKey };
  }
  if (environment !== 'development' && environment !== 'production') throw new Error('CS_WEB_ENVIRONMENT_NOT_CONFIGURED');
  if (environment === 'production' && process.env.AI_CS_PRODUCTION_ENABLED !== 'true') throw new Error('CS_PRODUCTION_DISABLED');
  const prefix = environment === 'development' ? 'AI_CS_DEV' : 'AI_CS_PROD';
  const endpoint = process.env[`${prefix}_APPS_SCRIPT_URL`];
  const apiKey = process.env[`${prefix}_APPS_SCRIPT_KEY`];
  if (!endpoint || !apiKey) throw new Error('CS_DATA_CONNECTION_NOT_CONFIGURED');
  return { environment, endpoint, apiKey };
}

function d1Target() {
  return { endpoint: new URL(DEFAULT_D1_API_URL), environment: 'development' as const };
}

function d1ReviewTarget() {
  if (process.env.AI_CS_WEB_ENVIRONMENT === 'production') return null;
  if (process.env.AI_CS_ENABLE_D1_REVIEW !== 'true') return null;
  // All D1 review/template/library mutations remain server-side and require an
  // explicit development-only opt-in plus the Worker sync credential.
  const syncKey = process.env.AI_CS_DEV_D1_SYNC_KEY;
  if (!syncKey) return null;
  try {
    const endpoint = new URL(DEFAULT_D1_API_URL);
    if (endpoint.protocol !== 'https:') throw new Error('D1_REVIEW_URL_NOT_HTTPS');
    return { endpoint, syncKey, environment: 'development' as const };
  } catch {
    throw new D1ReadError('CS_D1_REVIEW_TARGET_INVALID', 502);
  }
}

type D1WriteRequest = ReturnType<typeof normalizeReviewRequest> | ReturnType<typeof normalizeTemplateRequest> | ReturnType<typeof normalizeTemplateStateRequest> | ReturnType<typeof normalizeLibraryReviewRequest>;

function appsScriptWriteBody(writeRequest: D1WriteRequest | ReturnType<typeof normalizeSyncRequest>) {
  return writeRequest;
}

function privateJson(body: unknown, status = 200, cacheSeconds = 0) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}, stale-while-revalidate=60` : 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

class D1ReadError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number) { super(code); this.code = code; this.status = status; }
}

function d1Safety(payload: unknown): D1Payload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new D1ReadError('CS_D1_RESPONSE_INVALID', 502);
  const value = payload as D1Payload;
  if (value.ok === false) throw new D1ReadError(String(value.error ?? 'CS_D1_REJECTED'), 502);
  if (value.environment !== 'development' || value.auto_send !== false || Number(value.marketplace_write_actions) !== 0) {
    throw new D1ReadError('UNSAFE_OR_MISMATCHED_D1', 502);
  }
  return { ...value, environment: 'development', auto_send: false, marketplace_write_actions: 0 };
}

async function readD1(base: URL, path: string, params?: URLSearchParams): Promise<D1Payload> {
  const upstream = new URL(base);
  upstream.pathname = `${base.pathname.replace(/\/$/, '')}${path}`;
  if (params) upstream.search = params.toString();
  let response: Response;
  try {
    response = await fetch(upstream, { cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json' } });
  } catch { throw new D1ReadError('CS_D1_CONNECTION_FAILED', 502); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && !Array.isArray(payload) ? String((payload as D1Payload).error ?? `D1_HTTP_${response.status}`) : `D1_HTTP_${response.status}`;
    throw new D1ReadError(code, response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  return d1Safety(payload);
}

async function writeD1Review(target: NonNullable<ReturnType<typeof d1ReviewTarget>>, review: ReturnType<typeof normalizeReviewRequest>): Promise<D1Payload> {
  const upstream = new URL(target.endpoint);
  upstream.pathname = `${target.endpoint.pathname.replace(/\/$/, '')}/drafts/${encodeURIComponent(review.draft_id)}/review`;
  const body = Object.fromEntries(Object.entries(review).filter(([key]) => key !== 'action'));
  let response: Response;
  try {
    response = await fetch(upstream, {
      method: 'PATCH', cache: 'no-store', redirect: 'error',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CS-Sync-Key': target.syncKey },
      body: JSON.stringify(body),
    });
  } catch { throw new D1ReadError('CS_D1_REVIEW_CONNECTION_FAILED', 502); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && !Array.isArray(payload) ? String((payload as D1Payload).error ?? `D1_HTTP_${response.status}`) : `D1_HTTP_${response.status}`;
    throw new D1ReadError(code, response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  return d1Safety(payload);
}

async function writeD1Mutation(target: NonNullable<ReturnType<typeof d1ReviewTarget>>, request: D1WriteRequest): Promise<D1Payload> {
  const upstream = new URL(target.endpoint);
  let method = 'PATCH';
  if (request.action === 'reviewDraft') upstream.pathname = `${target.endpoint.pathname.replace(/\/$/, '')}/drafts/${encodeURIComponent(request.draft_id)}/review`;
  else if (request.action === 'upsertTemplate') { upstream.pathname = `${target.endpoint.pathname.replace(/\/$/, '')}/templates`; method = 'POST'; }
  else if (request.action === 'setTemplateState') upstream.pathname = `${target.endpoint.pathname.replace(/\/$/, '')}/templates/${encodeURIComponent(request.template_id)}`;
  else upstream.pathname = `${target.endpoint.pathname.replace(/\/$/, '')}/library/${encodeURIComponent(request.library_entry_id)}`;
  const body = Object.fromEntries(Object.entries(request).filter(([key]) => !['action', 'template_id', 'library_entry_id'].includes(key)));
  let response: Response;
  try {
    response = await fetch(upstream, { method, cache: 'no-store', redirect: 'error', headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CS-Sync-Key': target.syncKey }, body: JSON.stringify(body) });
  } catch { throw new D1ReadError('CS_D1_WRITE_CONNECTION_FAILED', 502); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === 'object' && !Array.isArray(payload) ? String((payload as D1Payload).error ?? `D1_HTTP_${response.status}`) : `D1_HTTP_${response.status}`;
    throw new D1ReadError(code, response.status >= 400 && response.status < 500 ? response.status : 502);
  }
  return d1Safety(payload);
}

function numberValue(value: unknown): number { const parsed = Number(value); return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0; }

function legacyTotal(overview: D1Payload, query: URLSearchParams): number {
  const draftState = query.get('ai_draft_state');
  const replyState = query.get('reply_state');
  if (draftState === 'READY') return numberValue(overview.ai_ready);
  if (replyState === 'NEEDS_REPLY') return numberValue(overview.needs_reply);
  if (replyState === 'ANSWERED') return numberValue(overview.answered);
  if (replyState === 'REVIEW') return numberValue(overview.review);
  if (replyState === 'NO_REPLY_REQUIRED') return numberValue(overview.no_reply_required);
  if (replyState === 'CLOSED') return 0;
  return numberValue(overview.total_live);
}

function legacyCaseList(cases: D1Payload, overview: D1Payload, query: URLSearchParams): D1Payload {
  const items = Array.isArray(cases.items) ? cases.items.map(legacyCaseFields) : [];
  return {
    ...cases,
    items,
    total: legacyTotal(overview, query),
  };
}

function legacyCaseFields(value: unknown): D1Payload {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value as D1Payload : {};
  return {
    ...item,
    category: item.category ?? item.category_masked ?? '',
    subject: item.subject ?? item.subject_masked ?? '',
    preview: item.preview ?? item.preview_masked ?? '',
    product_name: item.product_name ?? item.product_name_masked ?? '',
    source_reference: item.source_reference ?? item.source_reference_masked ?? '',
  };
}

function legacyDetail(payload: D1Payload): D1Payload {
  const rawCase = legacyCaseFields(payload.case);
  const messages = Array.isArray(payload.messages) ? payload.messages.map((item) => {
    const message = item && typeof item === 'object' && !Array.isArray(item) ? item as D1Payload : {};
    return {
      ...message,
      actor_type: message.actor_type ?? message.actor ?? 'UNKNOWN',
      message_at: message.message_at ?? message.sent_at ?? '',
      message_text_masked: message.message_text_masked ?? message.text_masked ?? '',
    };
  }) : [];
  const sellerMessages = messages.filter((item) => String(item.actor_type).toUpperCase() === 'SELLER');
  const reviewByDraft = new Map<string, D1Payload>();
  if (Array.isArray(payload.review_events)) {
    for (const item of payload.review_events) {
      const review = item && typeof item === 'object' && !Array.isArray(item) ? item as D1Payload : null;
      const draftId = String(review?.draft_id ?? '');
      if (review && draftId && !reviewByDraft.has(draftId)) reviewByDraft.set(draftId, review);
    }
  }
  const drafts = Array.isArray(payload.drafts) ? payload.drafts.map((item) => {
    const draft = item && typeof item === 'object' && !Array.isArray(item) ? item as D1Payload : {};
    const review = reviewByDraft.get(String(draft.draft_id ?? ''));
    return {
      ...draft,
      draft_text: draft.draft_text ?? draft.draft_text_masked ?? '',
      draft_state: review?.review_state ?? draft.draft_state ?? draft.state ?? '',
      generated_at: draft.generated_at ?? draft.created_at ?? '',
      pii_scan: draft.pii_scan ?? 'PASS',
      human_revision: review?.human_revision_masked ?? draft.human_revision ?? '',
      reviewed_at: review?.created_at ?? draft.reviewed_at ?? '',
    };
  }) : [];
  const latestSeller = sellerMessages.at(-1);
  return {
    ...payload,
    case: {
      ...rawCase,
      human_reply_exists: rawCase.human_reply_exists ?? Boolean(latestSeller),
      latest_human_reply_preview: rawCase.latest_human_reply_preview ?? latestSeller?.message_text_masked ?? '',
      human_reply_at: rawCase.human_reply_at ?? latestSeller?.message_at ?? '',
    },
    messages,
    drafts,
  };
}

export async function GET(request: NextRequest) {
  const action = request.nextUrl.searchParams.get('action') ?? 'overview';
  if (!ALLOWED_ACTIONS.has(action)) return privateJson({ ok: false, error: 'UNKNOWN_ACTION' }, 400);
  try { assertSingletonReadParams(request.nextUrl.searchParams); } catch (error) {
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'READ_PARAM_DUPLICATE' }, 400);
  }
  for (const key of request.nextUrl.searchParams.keys()) {
    if (!ALLOWED_PARAMS.has(key) && !LOCAL_ONLY_PARAMS.has(key)) return privateJson({ ok: false, error: `READ_PARAM_NOT_ALLOWED:${key}` }, 400);
  }
  if (action === 'case' && !request.nextUrl.searchParams.get('case_key')) return privateJson({ ok: false, error: 'CASE_KEY_REQUIRED' }, 400);
  if (action === 'caseBatch') {
    const rawKeys = request.nextUrl.searchParams.get('case_keys') ?? '';
    try { normalizeCaseBatchKeys(rawKeys); } catch (error) {
      return privateJson({ ok: false, error: error instanceof Error ? error.message : 'CASE_KEYS_INVALID' }, 400);
    }
  }

  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  const cacheKey = Array.from(request.nextUrl.searchParams.entries())
    .filter(([key]) => ALLOWED_PARAMS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const cached = responseCache.get(cacheKey);
  const isDetailAction = action === 'case' || action === 'caseBatch';
  if (!fresh && cached && cached.expiresAt > Date.now()) return privateJson(cached.payload, 200, isDetailAction ? 60 : 30);

  try {
    const target = d1Target();
    const query = new URLSearchParams();
    for (const key of ['market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state', 'limit', 'cursor'] as const) {
      const value = request.nextUrl.searchParams.get(key);
      if (value !== null) query.set(key, value);
    }
    const call = (path: string, params?: URLSearchParams) => readD1(target.endpoint, path, params);
    let safePayload: D1Payload;
    if (action === 'health') safePayload = await call('/health');
    else if (action === 'overview') safePayload = await call('/overview');
    else if (action === 'cases') {
      const [cases, overview] = await Promise.all([call('/cases', query), call('/overview')]);
      safePayload = legacyCaseList(cases, overview, query);
    } else if (action === 'dashboard') {
      const [cases, overview] = await Promise.all([call('/cases', query), call('/overview')]);
      safePayload = { ok: true, overview, ...legacyCaseList(cases, overview, query) };
    } else if (action === 'case') {
      safePayload = legacyDetail(await call(`/cases/${encodeURIComponent(request.nextUrl.searchParams.get('case_key') ?? '')}`));
    } else {
      const caseKeys = normalizeCaseBatchKeys(request.nextUrl.searchParams.get('case_keys') ?? '');
      const items = await Promise.all(caseKeys.map((caseKey) => call(`/cases/${encodeURIComponent(caseKey)}`).then(legacyDetail)));
      safePayload = { ok: true, items };
    }
    safePayload = { ...safePayload, environment: 'development', auto_send: false, marketplace_write_actions: 0 };
    responseCache.set(cacheKey, {
      payload: safePayload,
      expiresAt: Date.now() + (isDetailAction ? 120_000 : 60_000),
    });
    return privateJson(safePayload, 200, isDetailAction ? 60 : 30);
  } catch (error) {
    if (error instanceof D1ReadError) return privateJson({ ok: false, error: error.code, environment: 'development', auto_send: false, marketplace_write_actions: 0 }, error.status);
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'CS_DATA_CONNECTION_FAILED', environment: 'development', auto_send: false, marketplace_write_actions: 0 }, 502);
  }
}

export async function POST(request: NextRequest) {
  let writeRequest: D1WriteRequest | ReturnType<typeof normalizeSyncRequest>;
  try {
    const raw = await request.json() as Record<string, unknown>;
    writeRequest = raw?.action === 'syncRun' ? normalizeSyncRequest(raw)
      : raw?.action === 'upsertTemplate' ? normalizeTemplateRequest(raw)
        : raw?.action === 'setTemplateState' ? normalizeTemplateStateRequest(raw)
          : raw?.action === 'reviewLibraryEntry' ? normalizeLibraryReviewRequest(raw)
            : normalizeReviewRequest(raw);
  } catch (error) {
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'INVALID_WRITE_REQUEST', environment: 'development', auto_send: false, marketplace_write_actions: 0 }, 400);
  }

  let workerTarget: ReturnType<typeof d1ReviewTarget> = null;
  try {
    if (writeRequest.action !== 'syncRun') workerTarget = d1ReviewTarget();
  } catch (error) {
    const code = error instanceof D1ReadError ? error.code : 'CS_D1_REVIEW_TARGET_INVALID';
    return privateJson({ ok: false, error: code, environment: 'development', auto_send: false, marketplace_write_actions: 0 }, 502);
  }

  if (workerTarget && writeRequest.action !== 'syncRun') {
    try {
      const payload = writeRequest.action === 'reviewDraft'
        ? await writeD1Review(workerTarget, writeRequest)
        : await writeD1Mutation(workerTarget, writeRequest);
      responseCache.clear();
      return privateJson({ ...payload, environment: 'development', auto_send: false, marketplace_write_actions: 0 });
    } catch (error) {
      const status = error instanceof D1ReadError ? error.status : 502;
      const code = error instanceof D1ReadError ? error.code : 'CS_D1_REVIEW_CONNECTION_FAILED';
      return privateJson({ ok: false, error: code, environment: 'development', auto_send: false, marketplace_write_actions: 0 }, status);
    }
  }

  let target: ReturnType<typeof appsScriptTarget>;
  try {
    target = appsScriptTarget();
    if (target.environment !== 'development') throw new Error('DEVELOPMENT_WRITE_ONLY');
  } catch (error) {
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'CS_REVIEW_NOT_CONFIGURED', environment: 'unconfigured', auto_send: false, marketplace_write_actions: 0 }, 403);
  }

  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: 'application/json', 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...appsScriptWriteBody(writeRequest), api_key: target.apiKey, environment: target.environment }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload || payload.ok === false) {
      return privateJson({ ok: false, error: payload?.error ?? `UPSTREAM_HTTP_${response.status}` }, response.status >= 400 ? response.status : 502);
    }
    if ((payload.environment && payload.environment !== 'development') || (payload.auto_send !== undefined && payload.auto_send !== false) || Number(payload.marketplace_write_actions ?? 0) !== 0) {
      return privateJson({ ok: false, error: 'UNSAFE_OR_MISMATCHED_UPSTREAM', environment: 'development', auto_send: false }, 502);
    }
    responseCache.clear();
    return privateJson({ ...payload, environment: 'development', auto_send: false, marketplace_write_actions: 0 });
  } catch {
    return privateJson({ ok: false, error: 'CS_WRITE_CONNECTION_FAILED', environment: 'development', auto_send: false, marketplace_write_actions: 0 }, 502);
  }
}
