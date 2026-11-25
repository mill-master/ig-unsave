import test from 'node:test';
import assert from 'node:assert/strict';
import { pageOp } from '../extension/page.js';

// The unsave mutation as Instagram's page code defines it (shape only).
const unsaveArtifact = (rootField = 'xig_media_unsave', variable = 'input') => ({
  kind: 'Request',
  params: { id: '1234567890123456', name: 'PolarisAPIUnsavePostMutation', operationKind: 'mutation', text: null },
  operation: { argumentDefinitions: [{ name: variable }], selections: [{ name: rootField }] },
});

// A stand-in for the page: window.require over a table of modules, and the
// browser's cookies for the site.
function fakePage({ cookie = 'csrftoken=abc; ds_user_id=4242', onCommit, ...modules } = {}) {
  const committed = [];
  const table = {
    CurrentUserInitialData: { USER_ID: '0', NON_FACEBOOK_USER_ID: '17841400000000000' },
    PolarisRelayEnvironment: { default: { env: true } },
    CometRelay: {
      commitMutation: (env, config) => {
        committed.push(config);
        (onCommit || ((c) => c.onCompleted({ xig_media_unsave: { media: { id: '1' } } }, null)))(config);
      },
    },
    ...modules,
  };
  globalThis.window = { require: (name) => (name in table ? table[name] : undefined) };
  globalThis.document = { cookie };
  return committed;
}

test('check reports a logged-in page that can list and unsave', async () => {
  fakePage({ PolarisInstapi: { apiGet: async () => ({}) }, 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact() });
  assert.deepEqual(await pageOp('check', null), { ok: true, loggedIn: true, account: '17841400000000000', session: '4242', lister: true, unsaver: 'PolarisAPIUnsavePostMutation.graphql' });
});

test('check sees a logged-out page and a page without the unsave code', async () => {
  fakePage({ cookie: 'csrftoken=abc', CurrentUserInitialData: { USER_ID: '0', NON_FACEBOOK_USER_ID: '0' }, PolarisInstapi: { apiGet: async () => ({}) } });
  assert.deepEqual(await pageOp('check', null), { ok: true, loggedIn: false, account: '0', session: null, lister: true, unsaver: null });
});

test('a page without a module loader is refused', async () => {
  globalThis.window = {};
  assert.equal((await pageOp('check', null)).kind, 'page-changed');
});

test('list reads exact ids, shortcodes and the cursor', async () => {
  const seen = [];
  fakePage({
    PolarisInstapi: {
      apiGet: async (path, opts) => {
        seen.push([path, opts]);
        return {
          statusCode: 200,
          data: {
            items: [{ media: { id: '3123456789012345678_25025320', pk: 3123456789012345678, code: 'Cabc' } }, { media: { pk: '3123456789012345999', code: 'Cdef' } }],
            more_available: true,
            next_max_id: 'opaque-cursor',
          },
        };
      },
    },
  });
  assert.deepEqual(await pageOp('list', 'prev'), {
    ok: true,
    items: [
      { id: '3123456789012345678', code: 'Cabc' },
      { id: '3123456789012345999', code: 'Cdef' },
    ],
    more: true,
    next: 'opaque-cursor',
  });
  assert.deepEqual(seen, [['/api/v1/feed/saved/posts/', { query: { max_id: 'prev' } }]]);
  await pageOp('list', null);
  assert.deepEqual(seen[1][1], { query: {} });
});

test('list refuses an id it cannot read exactly', async () => {
  fakePage({ PolarisInstapi: { apiGet: async () => ({ data: { items: [{ media: { pk: 3123456789012345678, code: 'Cabc' } }] } }) } });
  const res = await pageOp('list', null);
  assert.equal(res.ok, false);
  assert.equal(res.kind, 'unexpected');
});

test('list reports a login page and an HTTP failure as they came', async () => {
  // As observed on the live site: the login page arrives as an object of characters.
  fakePage({ PolarisInstapi: { apiGet: async () => ({ statusCode: 200, data: { ...'<!DOCTYPE html><html>login' } }) } });
  assert.deepEqual(await pageOp('list', null), { ok: false, kind: 'html', detail: '<!DOCTYPE html><html>login' });
  fakePage({ PolarisInstapi: { apiGet: async () => ({ statusCode: 200, data: '<!DOCTYPE html><html>login' }) } });
  assert.equal((await pageOp('list', null)).kind, 'html');
  fakePage({
    PolarisInstapi: {
      apiGet: async () => {
        throw Object.assign(new Error('feedback_required'), { name: 'AjaxError', statusCode: 400, responseObject: { message: 'feedback_required', spam: true, feedback_title: 'Try Again Later' } });
      },
    },
  });
  const res = await pageOp('list', null);
  assert.equal(res.kind, 'http');
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.spam, true);
  assert.equal(res.body.message, 'feedback_required');
});

test('unsave commits the page mutation with the media id and nothing else', async () => {
  const artifact = unsaveArtifact();
  const committed = fakePage({ 'PolarisAPIUnsavePostMutation.graphql': artifact });
  assert.deepEqual(await pageOp('unsave', '3123456789012345678'), { ok: true });
  assert.equal(committed.length, 1);
  assert.equal(committed[0].mutation, artifact);
  assert.deepEqual(committed[0].variables, { input: { media_id: '3123456789012345678' } });
});

test('unsave sends nothing when the mutation is not loaded or is not the unsave mutation', async () => {
  let committed = fakePage({});
  assert.equal((await pageOp('unsave', '3123456789012345678')).kind, 'not-ready');
  assert.equal(committed.length, 0);
  committed = fakePage({ 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact('xig_media_save') });
  assert.equal((await pageOp('unsave', '3123456789012345678')).kind, 'not-ready');
  committed = fakePage({ 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact('xig_media_unsave', 'mediaId') });
  assert.equal((await pageOp('unsave', '3123456789012345678')).kind, 'not-ready');
  assert.equal(committed.length, 0);
  committed = fakePage({ 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact() });
  assert.equal((await pageOp('unsave', 'not-an-id')).kind, 'exception');
  assert.equal(committed.length, 0);
});

test('list and unsave refuse to act for another account than the run was started for', async () => {
  const committed = fakePage({ PolarisInstapi: { apiGet: async () => assert.fail('no list expected') }, 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact() });
  assert.deepEqual(await pageOp('list', null, '17841499999999999'), { ok: false, kind: 'account-changed' });
  assert.deepEqual(await pageOp('unsave', '3123456789012345678', '17841499999999999'), { ok: false, kind: 'account-changed' });
  assert.equal(committed.length, 0);
  assert.deepEqual(await pageOp('unsave', '3123456789012345678', '17841400000000000'), { ok: true });
});

test('list and unsave refuse to act once the browser is logged in as someone else, though the tab still shows the old account', async () => {
  const mods = { PolarisInstapi: { apiGet: async () => assert.fail('no list expected') }, 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact() };
  // Switched to another account in another tab: the cookie names the new one.
  let committed = fakePage({ cookie: 'csrftoken=abc; ds_user_id=777', ...mods });
  assert.deepEqual(await pageOp('list', null, '17841400000000000', '4242'), { ok: false, kind: 'account-changed' });
  assert.deepEqual(await pageOp('unsave', '3123456789012345678', '17841400000000000', '4242'), { ok: false, kind: 'account-changed' });
  assert.equal(committed.length, 0);
  // Logged out in another tab: the cookie is gone.
  committed = fakePage({ cookie: 'csrftoken=abc', ...mods });
  assert.deepEqual(await pageOp('unsave', '3123456789012345678', '17841400000000000', '4242'), { ok: false, kind: 'account-changed' });
  assert.equal(committed.length, 0);
  // Unchanged: the run goes on.
  fakePage({ cookie: 'ds_user_id=4242; csrftoken=abc', ...mods });
  assert.deepEqual(await pageOp('unsave', '3123456789012345678', '17841400000000000', '4242'), { ok: true });
});

test('unsave hands back Instagram’s errors', async () => {
  fakePage({ 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact(), onCommit: (c) => c.onError(Object.assign(new Error('blocked'), { source: { code: 1404006, errorMsg: '{"message":"feedback_required"}' } })) });
  let res = await pageOp('unsave', '3123456789012345678');
  assert.equal(res.kind, 'network');
  assert.equal(res.source.code, '1404006');
  // An HTTP refusal, as Instagram's network layer hands it over (observed 2026-11-25).
  fakePage({
    'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact(),
    onCommit: (c) => c.onError(Object.assign(new Error('Network request encountered error HTTP 429 HTTP_CLIENT_ERROR: '), { name: 'NetworkRequestError', source: { errorCode: 'HTTP_CLIENT_ERROR', errorMsg: '', errorRawTransportStatus: 429, errorType: 'HTTP 429' } })),
  });
  res = await pageOp('unsave', '3123456789012345678');
  assert.equal(res.statusCode, 429);
  assert.equal(res.source.errorType, 'HTTP 429');
  fakePage({ 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact(), onCommit: (c) => c.onCompleted(null, [{ message: 'Rate limit', severity: 'CRITICAL', code: 1675004 }]) });
  res = await pageOp('unsave', '3123456789012345678');
  assert.equal(res.kind, 'graphql');
  assert.equal(res.errors[0].message, 'Rate limit');
  fakePage({ 'PolarisAPIUnsavePostMutation.graphql': unsaveArtifact(), onCommit: (c) => c.onCompleted({ xig_media_unsave: null }, null) });
  assert.equal((await pageOp('unsave', '3123456789012345678')).kind, 'unexpected');
});
