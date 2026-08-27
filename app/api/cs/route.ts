import { NextRequest, NextResponse } from 'next/server';
import { normalizeReviewRequest, normalizeSyncRequest } from './policy';

export const dynamic = 'force-dynamic';

const ALLOWED_ACTIONS = new Set(['health', 'overview', 'cases', 'case']);
const ALLOWED_PARAMS = new Set(['action', 'case_key', 'record_type', 'market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state', 'limit', 'cursor']);
type CacheEntry = { expiresAt: number; payload: unknown };
const cacheScope = globalThis as typeof globalThis & { __pinkRocketCsCache?: Map<string, CacheEntry> };
const responseCache = cacheScope.__pinkRocketCsCache ?? new Map<string, CacheEntry>();
cacheScope.__pinkRocketCsCache = responseCache;
type WebEnvironment = 'development' | 'production';

function webTarget() {
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

function privateJson(body: unknown, status = 200, cacheSeconds = 0) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}, stale-while-revalidate=60` : 'private, no-store, max-age=0',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: NextRequest) {
  let target: ReturnType<typeof webTarget>;
  try {
    target = webTarget();
  } catch (error) {
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'CS_DATA_CONNECTION_NOT_CONFIGURED', environment: 'unconfigured', auto_send: false }, 503);
  }

  const action = request.nextUrl.searchParams.get('action') ?? 'overview';
  if (!ALLOWED_ACTIONS.has(action)) return privateJson({ ok: false, error: 'UNKNOWN_ACTION' }, 400);
  if (action === 'case' && !request.nextUrl.searchParams.get('case_key')) return privateJson({ ok: false, error: 'CASE_KEY_REQUIRED' }, 400);

  const fresh = request.nextUrl.searchParams.get('fresh') === '1';
  const cacheKey = Array.from(request.nextUrl.searchParams.entries())
    .filter(([key]) => ALLOWED_PARAMS.has(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
  const cached = responseCache.get(cacheKey);
  if (!fresh && cached && cached.expiresAt > Date.now()) return privateJson(cached.payload, 200, action === 'case' ? 60 : 30);

  const upstream = new URL(target.endpoint);
  request.nextUrl.searchParams.forEach((value, key) => {
    if (ALLOWED_PARAMS.has(key)) upstream.searchParams.set(key, value);
  });
  upstream.searchParams.set('action', action);
  upstream.searchParams.set('api_key', target.apiKey);
  upstream.searchParams.set('environment', target.environment);

  try {
    const response = await fetch(upstream, {
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: 'application/json' },
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload || payload.ok === false) {
      return privateJson({ ok: false, error: payload?.error ?? `UPSTREAM_HTTP_${response.status}` }, response.status >= 400 ? response.status : 502);
    }
    if (
      (payload.environment && payload.environment !== target.environment)
      || (payload.auto_send !== undefined && payload.auto_send !== false)
    ) {
      return privateJson({ ok: false, error: 'UNSAFE_OR_MISMATCHED_UPSTREAM', environment: target.environment, auto_send: false }, 502);
    }
    responseCache.set(cacheKey, {
      payload,
      expiresAt: Date.now() + (action === 'case' ? 120_000 : 60_000),
    });
    return privateJson(payload, 200, action === 'case' ? 60 : 30);
  } catch {
    return privateJson({ ok: false, error: 'CS_DATA_CONNECTION_FAILED' }, 502);
  }
}

export async function POST(request: NextRequest) {
  let target: ReturnType<typeof webTarget>;
  try {
    target = webTarget();
    if (target.environment !== 'development') throw new Error('DEVELOPMENT_WRITE_ONLY');
  } catch (error) {
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'CS_REVIEW_NOT_CONFIGURED', environment: 'unconfigured', auto_send: false }, 403);
  }

  let writeRequest: ReturnType<typeof normalizeReviewRequest> | ReturnType<typeof normalizeSyncRequest>;
  try {
    const raw = await request.json() as Record<string, unknown>;
    writeRequest = raw?.action === 'syncRun' ? normalizeSyncRequest(raw) : normalizeReviewRequest(raw);
  } catch (error) {
    return privateJson({ ok: false, error: error instanceof Error ? error.message : 'INVALID_WRITE_REQUEST', environment: target.environment, auto_send: false }, 400);
  }

  try {
    const response = await fetch(target.endpoint, {
      method: 'POST',
      cache: 'no-store',
      redirect: 'follow',
      headers: { Accept: 'application/json', 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ ...writeRequest, api_key: target.apiKey, environment: target.environment }),
    });
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !payload || payload.ok === false) {
      return privateJson({ ok: false, error: payload?.error ?? `UPSTREAM_HTTP_${response.status}` }, response.status >= 400 ? response.status : 502);
    }
    if ((payload.environment && payload.environment !== 'development') || (payload.auto_send !== undefined && payload.auto_send !== false) || Number(payload.marketplace_write_actions ?? 0) !== 0) {
      return privateJson({ ok: false, error: 'UNSAFE_OR_MISMATCHED_UPSTREAM', environment: 'development', auto_send: false }, 502);
    }
    responseCache.clear();
    return privateJson(payload);
  } catch {
    return privateJson({ ok: false, error: 'CS_WRITE_CONNECTION_FAILED', environment: 'development', auto_send: false }, 502);
  }
}
