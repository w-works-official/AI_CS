import assert from 'node:assert/strict';
import test from 'node:test';
import { NextRequest } from 'next/server.js';
import { GET, POST } from './route.ts';

const safety = { environment: 'development', auto_send: false, marketplace_write_actions: 0 };

function request(path: string, init: ConstructorParameters<typeof NextRequest>[1] = {}) {
  return new NextRequest(`https://review.example${path}`, init);
}

function d1Response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify({ ...body, ...safety }), { status, headers: { 'Content-Type': 'application/json' } });
}

test('legacy dashboard and detail actions map to the fixed development D1 API', async () => {
  const previousFetch = globalThis.fetch;
  const calls: URL[] = [];
  const redirectModes: Array<RequestRedirect | undefined> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    redirectModes.push(init?.redirect);
    if (url.pathname === '/api/cs/cases') return d1Response({ ok: true, items: [{ case_key: 'case-1', reply_state: 'NEEDS_REPLY', category_masked: '배송', subject_masked: '문의 제목', preview_masked: '문의 미리보기', product_name_masked: '상품명', source_reference_masked: '참조값' }], cursor: 0, next_cursor: 50 });
    if (url.pathname === '/api/cs/overview') return d1Response({ ok: true, total_live: 9, needs_reply: 2, answered: 3, review: 1, no_reply_required: 2, ai_ready: 1, by_market: {} });
    if (url.pathname === '/api/cs/cases/case-1') return d1Response({
      ok: true,
      case: { case_key: 'case-1', reply_state: 'ANSWERED', category_masked: '배송', subject_masked: '문의 제목', preview_masked: '문의 미리보기', product_name_masked: '상품명', source_reference_masked: '참조값' },
      messages: [{ actor: 'CUSTOMER', sent_at: '2026-09-01T00:00:00.000Z', text_masked: '질문' }, { actor: 'SELLER', sent_at: '2026-09-01T00:01:00.000Z', text_masked: '답변' }],
      drafts: [{ draft_id: 'draft-1', state: 'READY', created_at: '2026-09-01T00:02:00.000Z', draft_text_masked: '초안' }],
      review_events: [{ draft_id: 'draft-1', review_state: 'APPROVED', human_revision_masked: '사람 수정본', created_at: '2026-09-01T00:03:00.000Z' }],
    });
    return d1Response({ ok: false, error: 'UNEXPECTED' }, 404);
  };
  try {
    const dashboard = await GET(request('/api/cs?action=dashboard&reply_state=NEEDS_REPLY&fresh=1'));
    assert.equal(dashboard.status, 200);
    const dashboardBody = await dashboard.json() as Record<string, unknown>;
    assert.equal(dashboardBody.total, 2);
    assert.equal((dashboardBody.overview as Record<string, unknown>).total_live, 9);
    assert.deepEqual((dashboardBody.items as Array<Record<string, unknown>>)[0], { case_key: 'case-1', reply_state: 'NEEDS_REPLY', category_masked: '배송', subject_masked: '문의 제목', preview_masked: '문의 미리보기', product_name_masked: '상품명', source_reference_masked: '참조값', category: '배송', subject: '문의 제목', preview: '문의 미리보기', product_name: '상품명', source_reference: '참조값' });
    assert.equal(dashboardBody.environment, 'development');
    assert.equal(calls.every((url) => url.origin === 'https://ai-cs-mcp-development.kimhyein0214.workers.dev'), true);
    assert.equal(redirectModes.every((mode) => mode === 'manual'), true);
    assert.deepEqual(calls.map((url) => url.pathname).sort(), ['/api/cs/cases', '/api/cs/overview']);
    assert.equal(calls.find((url) => url.pathname.endsWith('/cases'))?.searchParams.get('reply_state'), 'NEEDS_REPLY');

    calls.length = 0;
    const detail = await GET(request('/api/cs?action=case&case_key=case-1&fresh=1'));
    const detailBody = await detail.json() as Record<string, unknown>;
    const messages = detailBody.messages as Array<Record<string, unknown>>;
    const drafts = detailBody.drafts as Array<Record<string, unknown>>;
    assert.equal(calls[0]?.pathname, '/api/cs/cases/case-1');
    assert.equal(messages[1].actor_type, 'SELLER');
    assert.equal(messages[1].message_at, '2026-09-01T00:01:00.000Z');
    assert.equal(messages[1].message_text_masked, '답변');
    assert.equal(drafts[0].generated_at, '2026-09-01T00:02:00.000Z');
    assert.equal(drafts[0].draft_text, '초안');
    assert.equal(drafts[0].draft_state, 'APPROVED');
    assert.equal(drafts[0].human_revision, '사람 수정본');
    assert.equal(drafts[0].reviewed_at, '2026-09-01T00:03:00.000Z');
    assert.deepEqual(detailBody.case, { case_key: 'case-1', reply_state: 'ANSWERED', category_masked: '배송', subject_masked: '문의 제목', preview_masked: '문의 미리보기', product_name_masked: '상품명', source_reference_masked: '참조값', category: '배송', subject: '문의 제목', preview: '문의 미리보기', product_name: '상품명', source_reference: '참조값', human_reply_exists: true, latest_human_reply_preview: '답변', human_reply_at: '2026-09-01T00:01:00.000Z' });
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('caseBatch stays compatible and reads each bounded case from D1', async () => {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const caseKey = url.pathname.split('/').at(-1) ?? '';
    return d1Response({ ok: true, case: { case_key: caseKey }, messages: [], drafts: [] });
  };
  try {
    const response = await GET(request('/api/cs?action=caseBatch&case_keys=case-1,case-2&fresh=1'));
    assert.equal(response.status, 200);
    const body = await response.json() as Record<string, unknown>;
    assert.deepEqual((body.items as Array<Record<string, unknown>>).map((item) => (item.case as Record<string, unknown>).case_key), ['case-1', 'case-2']);
    assert.equal(body.environment, 'development');
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('POST forwards the complete normalized review to the Apps Script D1 relay', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnvironment = process.env.AI_CS_WEB_ENVIRONMENT;
  const previousUrl = process.env.AI_CS_DEV_APPS_SCRIPT_URL;
  const previousKey = process.env.AI_CS_DEV_APPS_SCRIPT_KEY;
  const previousD1SyncKey = process.env.AI_CS_DEV_D1_SYNC_KEY;
  const previousD1ReviewEnabled = process.env.AI_CS_ENABLE_D1_REVIEW;
  const previousMarketplaceSyncKey = process.env.MARKETPLACE_CS_SYNC_KEY;
  const captured: { upstream?: string; body?: string } = {};
  process.env.AI_CS_WEB_ENVIRONMENT = 'development';
  process.env.AI_CS_DEV_APPS_SCRIPT_URL = 'https://script.example/exec';
  process.env.AI_CS_DEV_APPS_SCRIPT_KEY = 'apps-script-only-test-key';
  delete process.env.AI_CS_DEV_D1_SYNC_KEY;
  delete process.env.AI_CS_ENABLE_D1_REVIEW;
  delete process.env.MARKETPLACE_CS_SYNC_KEY;
  globalThis.fetch = async (input, init) => {
    captured.upstream = new URL(input instanceof Request ? input.url : String(input)).href;
    captured.body = String(init?.body);
    return new Response(JSON.stringify({ ok: true, ...safety }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'reviewDraft',
      draft_id: 'DRAFT:test', draft_state: 'REJECTED', review_note: '', human_revision: '',
      composition_source_type: 'MANUAL', composition_source_id: 'MANUAL', composition_source_version: 'v1',
      base_text_hash: 'a'.repeat(64), final_text_hash: 'b'.repeat(64), unresolved_variables: [], source_content_hash: 'c'.repeat(64),
      ...safety,
    }) }));
    assert.equal(response.status, 200);
    const written = JSON.parse(captured.body ?? '') as Record<string, unknown>;
    assert.equal(captured.upstream, 'https://script.example/exec');
    assert.equal(written.api_key, 'apps-script-only-test-key');
    assert.equal(written.action, 'reviewDraft');
    assert.equal(written.composition_source_type, 'MANUAL');
    assert.equal(written.final_text_hash, 'b'.repeat(64));
    assert.equal(written.environment, 'development');
    assert.equal(written.auto_send, false);
    assert.equal(written.marketplace_write_actions, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnvironment === undefined) delete process.env.AI_CS_WEB_ENVIRONMENT; else process.env.AI_CS_WEB_ENVIRONMENT = previousEnvironment;
    if (previousUrl === undefined) delete process.env.AI_CS_DEV_APPS_SCRIPT_URL; else process.env.AI_CS_DEV_APPS_SCRIPT_URL = previousUrl;
    if (previousKey === undefined) delete process.env.AI_CS_DEV_APPS_SCRIPT_KEY; else process.env.AI_CS_DEV_APPS_SCRIPT_KEY = previousKey;
    if (previousD1SyncKey === undefined) delete process.env.AI_CS_DEV_D1_SYNC_KEY; else process.env.AI_CS_DEV_D1_SYNC_KEY = previousD1SyncKey;
    if (previousD1ReviewEnabled === undefined) delete process.env.AI_CS_ENABLE_D1_REVIEW; else process.env.AI_CS_ENABLE_D1_REVIEW = previousD1ReviewEnabled;
    if (previousMarketplaceSyncKey === undefined) delete process.env.MARKETPLACE_CS_SYNC_KEY; else process.env.MARKETPLACE_CS_SYNC_KEY = previousMarketplaceSyncKey;
  }
});

test('POST forwards template and learning mutations to the Apps Script D1 relay when direct D1 writes are disabled', async () => {
  const previousFetch = globalThis.fetch;
  const previousEnvironment = process.env.AI_CS_WEB_ENVIRONMENT;
  const previousUrl = process.env.AI_CS_DEV_APPS_SCRIPT_URL;
  const previousKey = process.env.AI_CS_DEV_APPS_SCRIPT_KEY;
  const previousD1SyncKey = process.env.AI_CS_DEV_D1_SYNC_KEY;
  const previousD1ReviewEnabled = process.env.AI_CS_ENABLE_D1_REVIEW;
  const captured: Array<Record<string, unknown>> = [];
  process.env.AI_CS_WEB_ENVIRONMENT = 'development';
  process.env.AI_CS_DEV_APPS_SCRIPT_URL = 'https://script.example/exec';
  process.env.AI_CS_DEV_APPS_SCRIPT_KEY = 'apps-script-only-test-key';
  delete process.env.AI_CS_DEV_D1_SYNC_KEY;
  delete process.env.AI_CS_ENABLE_D1_REVIEW;
  globalThis.fetch = async (_input, init) => {
    captured.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ ok: true, ...safety }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const template = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'upsertTemplate', template_key: 'delivery', template_version: 'v1', template_name: '배송 안내', template_text: '확인 후 안내드리겠습니다.', quality_state: 'USE', ...safety,
    }) }));
    const learning = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'reviewLibraryEntry', library_entry_id: 'ANSWER:reviewed', quality_state: 'USE', review_note: '사람 검증 완료', ...safety,
    }) }));
    assert.equal(template.status, 200);
    assert.equal(learning.status, 200);
    assert.deepEqual(captured.map((item) => item.action), ['upsertTemplate', 'reviewLibraryEntry']);
    assert.equal(captured.every((item) => item.api_key === 'apps-script-only-test-key' && item.environment === 'development' && item.auto_send === false && item.marketplace_write_actions === 0), true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousEnvironment === undefined) delete process.env.AI_CS_WEB_ENVIRONMENT; else process.env.AI_CS_WEB_ENVIRONMENT = previousEnvironment;
    if (previousUrl === undefined) delete process.env.AI_CS_DEV_APPS_SCRIPT_URL; else process.env.AI_CS_DEV_APPS_SCRIPT_URL = previousUrl;
    if (previousKey === undefined) delete process.env.AI_CS_DEV_APPS_SCRIPT_KEY; else process.env.AI_CS_DEV_APPS_SCRIPT_KEY = previousKey;
    if (previousD1SyncKey === undefined) delete process.env.AI_CS_DEV_D1_SYNC_KEY; else process.env.AI_CS_DEV_D1_SYNC_KEY = previousD1SyncKey;
    if (previousD1ReviewEnabled === undefined) delete process.env.AI_CS_ENABLE_D1_REVIEW; else process.env.AI_CS_ENABLE_D1_REVIEW = previousD1ReviewEnabled;
  }
});

test('POST uses the development Worker PATCH review route only with the explicit D1 sync key', async () => {
  const previousFetch = globalThis.fetch;
  const previousD1SyncKey = process.env.AI_CS_DEV_D1_SYNC_KEY;
  const previousD1ReviewEnabled = process.env.AI_CS_ENABLE_D1_REVIEW;
  const previousMarketplaceSyncKey = process.env.MARKETPLACE_CS_SYNC_KEY;
  const previousD1Url = process.env.AI_CS_D1_API_URL;
  const captured: { url?: string; method?: string; redirect?: RequestRedirect; syncKey?: string | null; body?: Record<string, unknown> } = {};
  process.env.AI_CS_DEV_D1_SYNC_KEY = 'worker-test-sync-key';
  process.env.AI_CS_ENABLE_D1_REVIEW = 'true';
  delete process.env.MARKETPLACE_CS_SYNC_KEY;
  process.env.AI_CS_D1_API_URL = 'https://worker.example/api/cs';
  globalThis.fetch = async (input, init) => {
    captured.url = new URL(input instanceof Request ? input.url : String(input)).href;
    captured.method = init?.method;
    captured.redirect = init?.redirect;
    captured.syncKey = new Headers(init?.headers).get('X-CS-Sync-Key');
    captured.body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ ok: true, draft_id: 'DRAFT:worker', ...safety }), { headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const response = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      draft_id: 'DRAFT:worker', draft_state: 'APPROVED', review_note: 'checked', human_revision: 'masked revision',
      composition_source_type: 'AI_DRAFT', composition_source_id: 'DRAFT:worker', composition_source_version: 'v1',
      base_text_hash: 'a'.repeat(64), final_text_hash: 'b'.repeat(64), unresolved_variables: [], source_content_hash: 'c'.repeat(64),
      ...safety,
    }) }));
    assert.equal(response.status, 200);
    assert.equal(captured.url, 'https://ai-cs-mcp-development.kimhyein0214.workers.dev/api/cs/drafts/DRAFT%3Aworker/review');
    assert.equal(captured.method, 'PATCH');
    assert.equal(captured.redirect, 'manual');
    assert.equal(captured.syncKey, 'worker-test-sync-key');
    assert.deepEqual(captured.body, {
      draft_id: 'DRAFT:worker', draft_state: 'APPROVED', review_note: 'checked', human_revision: 'masked revision',
      composition_source_type: 'AI_DRAFT', composition_source_id: 'DRAFT:worker', composition_source_version: 'v1',
      base_text_hash: 'a'.repeat(64), final_text_hash: 'b'.repeat(64), unresolved_variables: [], source_content_hash: 'c'.repeat(64),
      ...safety,
    });
  } finally {
    globalThis.fetch = previousFetch;
    if (previousD1SyncKey === undefined) delete process.env.AI_CS_DEV_D1_SYNC_KEY; else process.env.AI_CS_DEV_D1_SYNC_KEY = previousD1SyncKey;
    if (previousD1ReviewEnabled === undefined) delete process.env.AI_CS_ENABLE_D1_REVIEW; else process.env.AI_CS_ENABLE_D1_REVIEW = previousD1ReviewEnabled;
    if (previousMarketplaceSyncKey === undefined) delete process.env.MARKETPLACE_CS_SYNC_KEY; else process.env.MARKETPLACE_CS_SYNC_KEY = previousMarketplaceSyncKey;
    if (previousD1Url === undefined) delete process.env.AI_CS_D1_API_URL; else process.env.AI_CS_D1_API_URL = previousD1Url;
  }
});

test('POST routes template and learning-library mutations only through the development Worker', async () => {
  const previousFetch = globalThis.fetch;
  const previousD1SyncKey = process.env.AI_CS_DEV_D1_SYNC_KEY;
  const previousD1ReviewEnabled = process.env.AI_CS_ENABLE_D1_REVIEW;
  const captured: Array<{ path: string; method?: string; body: Record<string, unknown> }> = [];
  process.env.AI_CS_DEV_D1_SYNC_KEY = 'worker-test-sync-key';
  process.env.AI_CS_ENABLE_D1_REVIEW = 'true';
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    captured.push({ path: url.pathname, method: init?.method, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
    return d1Response({ ok: true });
  };
  try {
    const template = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
      action: 'upsertTemplate', template_key: 'delivery', template_version: 'v1', template_name: '배송 안내', template_text: '확인 후 안내드리겠습니다.', required_checks: ['출고일 확인'], quality_state: 'USE', ...safety,
    }) }));
    assert.equal(template.status, 200);
    const disable = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'setTemplateState', template_id: 'TEMPLATE:delivery', quality_state: 'EXCLUDE', ...safety }) }));
    assert.equal(disable.status, 200);
    const learn = await POST(request('/api/cs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reviewLibraryEntry', library_entry_id: 'ANSWER:reviewed', quality_state: 'USE', review_note: '사람 검증 완료', ...safety }) }));
    assert.equal(learn.status, 200);
    assert.deepEqual(captured.map(({ path, method }) => ({ path, method })), [
      { path: '/api/cs/templates', method: 'POST' },
      { path: '/api/cs/templates/TEMPLATE%3Adelivery', method: 'PATCH' },
      { path: '/api/cs/library/ANSWER%3Areviewed', method: 'PATCH' },
    ]);
    assert.equal(captured.every(({ body }) => body.environment === 'development' && body.auto_send === false && body.marketplace_write_actions === 0), true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousD1SyncKey === undefined) delete process.env.AI_CS_DEV_D1_SYNC_KEY; else process.env.AI_CS_DEV_D1_SYNC_KEY = previousD1SyncKey;
    if (previousD1ReviewEnabled === undefined) delete process.env.AI_CS_ENABLE_D1_REVIEW; else process.env.AI_CS_ENABLE_D1_REVIEW = previousD1ReviewEnabled;
  }
});
