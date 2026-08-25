import { NextRequest, NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

const ALLOWED_ACTIONS = new Set(['health', 'overview', 'cases', 'case']);
const ALLOWED_PARAMS = new Set(['action', 'case_key', 'record_type', 'market', 'channel', 'ui_type', 'reply_state', 'ai_draft_state', 'limit', 'cursor']);
type CacheEntry = { expiresAt: number; payload: unknown };
const cacheScope = globalThis as typeof globalThis & { __pinkRocketCsCache?: Map<string, CacheEntry> };
const responseCache = cacheScope.__pinkRocketCsCache ?? new Map<string, CacheEntry>();
cacheScope.__pinkRocketCsCache = responseCache;
const publicWebOrigin = process.env.CS_PUBLIC_WEB_ORIGIN ?? 'https://w-works-official.github.io';

function privateJson(body: unknown, status = 200, cacheSeconds = 0) {
  return NextResponse.json(body, {
    status,
    headers: {
      'Cache-Control': cacheSeconds > 0 ? `private, max-age=${cacheSeconds}, stale-while-revalidate=60` : 'private, no-store, max-age=0',
      'Access-Control-Allow-Origin': publicWebOrigin,
      'Vary': 'Origin',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export async function GET(request: NextRequest) {
  const endpoint = process.env.MARKETPLACE_CS_SYNC_URL;
  const apiKey = process.env.MARKETPLACE_CS_SYNC_KEY;
  if (!endpoint || !apiKey) return privateJson({ ok: false, error: 'CS_DATA_CONNECTION_NOT_CONFIGURED' }, 503);

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

  const upstream = new URL(endpoint);
  request.nextUrl.searchParams.forEach((value, key) => {
    if (ALLOWED_PARAMS.has(key)) upstream.searchParams.set(key, value);
  });
  upstream.searchParams.set('action', action);
  upstream.searchParams.set('api_key', apiKey);

  try {
    const response = await fetch(upstream, { cache: 'no-store', redirect: 'follow', headers: { Accept: 'application/json' } });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload || payload.ok === false) {
      return privateJson({ ok: false, error: payload?.error ?? `UPSTREAM_HTTP_${response.status}` }, response.status >= 400 ? response.status : 502);
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
