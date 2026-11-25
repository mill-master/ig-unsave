import test from 'node:test';
import assert from 'node:assert/strict';
import { PACES, COOLDOWN_MS, begin, classify, freshState, gapMs, halt, startRefusal, step } from '../extension/core.js';

// A stand-in for Instagram: a saved list served in pages, newest first.
function fakeInstagram(count, { pageSize = 21, lagPages = 0 } = {}) {
  let saved = Array.from({ length: count }, (_, i) => ({ id: String(3000000000000000000n + BigInt(i)), code: `code${i}` }));
  const removed = [];
  const calls = [];
  let lag = lagPages;
  return {
    calls,
    removed,
    left: () => saved.length,
    list: async (cursor) => {
      calls.push({ op: 'list', cursor });
      // A lagging list still shows posts that were just unsaved.
      const view = lag > 0 ? [...removed.map((id) => ({ id, code: '' })), ...saved] : saved;
      if (lag > 0) lag -= 1;
      const from = cursor ? Number(cursor) : 0;
      const items = view.slice(from, from + pageSize);
      const more = from + pageSize < view.length;
      return { ok: true, items, more, next: more ? String(from + pageSize) : null };
    },
    unsave: async (id) => {
      calls.push({ op: 'unsave', id });
      assert.ok(saved.some((p) => p.id === id), `unsave of a post that is not saved: ${id}`);
      saved = saved.filter((p) => p.id !== id);
      removed.push(id);
      return { ok: true };
    },
  };
}

// What a step is given by its host: the clock, a random source, a store and
// the two page calls.
const host = (ig, now, random = () => 0) => ({ now, random, persist: async () => {}, list: ig.list, unsave: ig.unsave });

// Drive a run the way the alarm does: jump the clock to each due time.
async function run(state, ig, { maxSteps = 2000, random = () => 0.5 } = {}) {
  let now = state.nextAt;
  const times = [];
  let s = state;
  for (let i = 0; i < maxSteps && s.status === 'running'; i += 1) {
    const before = ig.calls.length;
    s = await step(s, host(ig, () => now, random));
    const made = ig.calls.length - before;
    assert.ok(made <= 1, 'a step makes at most one request');
    if (made === 1) times.push(now);
    if (s.status === 'running') now = s.nextAt;
  }
  return { s, times, now };
}

const started = (over = {}) => begin(freshState(), { tabId: 7, pace: 'careful', target: null, now: 1_000_000, ...over });

test('every pace draws its gaps from the range it names, none shorter than 10 s', () => {
  for (const name of Object.keys(PACES)) {
    const p = PACES[name];
    assert.ok(p.gapMin >= 10 && p.gapMin <= p.gapMax, `${name} range`);
    assert.equal(gapMs(name, () => 0), p.gapMin * 1000);
    assert.ok(gapMs(name, () => 0.999999) <= p.gapMax * 1000);
  }
});

test('a fixed pace keeps exactly its gap, and holds it when Stop is followed by Start', async () => {
  const ig = fakeInstagram(5);
  const { s, times } = await run(started({ pace: 'every10' }), ig);
  assert.equal(s.reason.kind, 'done');
  assert.equal(times.length, 7, 'the list, five unsaves and the list that comes back empty');
  for (let i = 1; i < times.length; i += 1) assert.equal(times[i] - times[i - 1], 10_000);
  const again = begin(s, { tabId: 7, pace: 'every10', target: null, now: s.lastAt + 2000 });
  const early = await step(again, host(ig, () => s.lastAt + 2000));
  assert.equal(early.nextAt, s.lastAt + 10_000);
});

test('a run unsaves every post once, one request per step, never faster than the pace', async () => {
  const ig = fakeInstagram(45);
  const { s, times } = await run(started(), ig);
  assert.equal(s.status, 'stopped');
  assert.equal(s.reason.kind, 'done');
  assert.equal(ig.left(), 0);
  assert.equal(s.runCount, 45);
  assert.equal(new Set(ig.removed).size, 45);
  assert.equal(ig.calls.filter((c) => c.op === 'list').length, 4, 'three pages and the empty one');
  for (let i = 1; i < times.length; i += 1) {
    assert.ok(times[i] - times[i - 1] >= PACES.careful.gapMin * 1000, 'gap between requests');
  }
});

test('a list that lags behind does not cause a second unsave', async () => {
  const ig = fakeInstagram(30, { lagPages: 3 });
  const { s } = await run(started(), ig);
  assert.equal(s.reason.kind, 'done');
  assert.equal(ig.left(), 0);
  assert.equal(ig.calls.filter((c) => c.op === 'unsave').length, 30);
});

test('the run stops at the number asked for', async () => {
  const ig = fakeInstagram(45);
  const { s } = await run(started({ target: 5 }), ig);
  assert.equal(s.reason.kind, 'limit');
  assert.equal(s.runCount, 5);
  assert.equal(ig.left(), 40);
});

test('an empty saved list ends the run without an unsave', async () => {
  const ig = fakeInstagram(0);
  const { s } = await run(started(), ig);
  assert.equal(s.reason.kind, 'done');
  assert.deepEqual(ig.calls, [{ op: 'list', cursor: null }]);
});

test('no request leaves sooner than the gap after the one before, however the step came about', async () => {
  const ig = fakeInstagram(10);
  const t0 = 1_000_000;
  let s = await step(started({ now: t0 }), host(ig, () => t0));
  assert.equal(ig.calls.length, 1, 'the list request, sent at t0');
  assert.equal(s.lastAt, t0);
  // Stop, then Start again three seconds after that request.
  s = begin(halt(s, t0 + 2000, 'user', 'Stopped by you.'), { tabId: 7, pace: 'careful', target: null, now: t0 + 3000 });
  const early = await step(s, host(ig, () => t0 + 3000));
  assert.equal(ig.calls.length, 1, 'nothing more is sent yet');
  assert.equal(early.status, 'running');
  assert.equal(early.nextAt, t0 + PACES.careful.gapMin * 1000);
  const due = await step(early, host(ig, () => early.nextAt));
  assert.equal(ig.calls.length, 2);
  assert.equal(due.lastAt, early.nextAt);
  // The slower pace asks for its own, longer gap after the same request.
  const slow = await step(begin(halt(due, due.lastAt + 1000, 'user', 'x'), { tabId: 7, pace: 'slower', target: null, now: due.lastAt + 31_000 }), host(ig, () => due.lastAt + 31_000));
  assert.equal(ig.calls.length, 2);
  assert.equal(slow.nextAt, due.lastAt + PACES.slower.gapMin * 1000);
});

test('the time of a request is stored before the request is sent', async () => {
  const ig = fakeInstagram(3);
  const events = [];
  const deps = {
    now: () => 5_000_000,
    random: () => 0,
    persist: async (state) => events.push(`stored ${state.lastAt}`),
    list: async (cursor) => {
      events.push('list');
      return ig.list(cursor);
    },
    unsave: async (id) => {
      events.push('unsave');
      return ig.unsave(id);
    },
  };
  let s = await step(started({ now: 5_000_000 }), deps);
  s = await step(s, { ...deps, now: () => s.nextAt, persist: async (state) => events.push(`stored ${state.lastAt}`) });
  assert.deepEqual(events, ['stored 5000000', 'list', `stored ${s.lastAt}`, 'unsave']);
});

test('an activity block stops the run and locks Start for a day', async () => {
  const ig = fakeInstagram(10);
  ig.unsave = async () => ({ ok: false, kind: 'network', error: { name: 'RelayNetwork' }, source: { code: '1404006' } });
  const { s, now } = await run(started(), ig);
  assert.equal(s.reason.kind, 'blocked');
  assert.equal(s.notBefore, now + COOLDOWN_MS.blocked);
  assert.match(startRefusal(s, now + COOLDOWN_MS.blocked - 1), /locked/);
  assert.equal(startRefusal(s, now + COOLDOWN_MS.blocked), null);
});

test('a throttle stops the run and locks Start for an hour', async () => {
  const ig = fakeInstagram(10);
  ig.list = async () => ({ ok: false, kind: 'http', statusCode: 429, body: null, text: '' });
  const { s, now } = await run(started(), ig);
  assert.equal(s.reason.kind, 'throttled');
  assert.equal(s.notBefore, now + COOLDOWN_MS.throttled);
});

test('an unsave refused with HTTP 429 locks Start as a throttle', async () => {
  const ig = fakeInstagram(10);
  let refused = 0;
  // As Instagram's network layer reported it when fed a 429 (observed 2026-11-25).
  ig.unsave = async () => {
    refused += 1;
    return { ok: false, kind: 'network', statusCode: 429, error: { name: 'NetworkRequestError', message: 'Network request encountered error HTTP 429 HTTP_CLIENT_ERROR: ', type: 'error' }, source: { errorMsg: '', errorType: 'HTTP 429' } };
  };
  const { s, now } = await run(started(), ig);
  assert.equal(s.reason.kind, 'throttled');
  assert.equal(s.notBefore, now + COOLDOWN_MS.throttled);
  assert.equal(refused, 1, 'the refused unsave is not tried again');
});

test('a refusal of an unsave that cannot be read names the post it happened on', async () => {
  const ig = fakeInstagram(3);
  ig.unsave = async () => ({ ok: false, kind: 'network', statusCode: null, error: { name: 'RelayNetwork', message: 'No data returned for operation' }, source: {} });
  const { s } = await run(started(), ig);
  assert.equal(s.reason.kind, 'error');
  assert.match(s.reason.text, /instagram\.com\/p\/code0\. If that post stops the run again, unsave it by hand\./);
  assert.equal(s.notBefore, null);
});

test('a post unsaved a short while ago is passed over, and an hour later it is not', async () => {
  const id = '3000000000000000000';
  const page = { unsaves: 0, list: async () => ({ ok: true, items: [{ id, code: 'again' }], more: false, next: null }) };
  page.unsave = async () => {
    page.unsaves += 1;
    return { ok: true };
  };
  const t0 = 1_000_000;
  const base = { ...started({ now: t0 }), recent: [{ id, at: t0 }] };
  const soon = await step(base, host(page, () => t0 + 10 * 60_000));
  assert.equal(soon.reason.kind, 'done');
  assert.match(soon.reason.text, /nothing but 1 post that this extension unsaved a short while ago/);
  assert.equal(page.unsaves, 0);
  const later = await step(base, host(page, () => t0 + 61 * 60_000));
  assert.equal(later.status, 'running');
  assert.deepEqual(later.queue, [{ id, code: 'again' }]);
  assert.deepEqual(later.recent, []);
});

test('what one account unsaved is forgotten when a run starts for another', () => {
  const stopped = halt({ ...started({ account: 'a' }), recent: [{ id: '3000000000000000000', at: 1_000_000 }] }, 1_000_500, 'user', 'Stopped by you.');
  assert.equal(begin(stopped, { tabId: 7, account: 'a', pace: 'careful', target: null, now: 1_001_000 }).recent.length, 1);
  assert.equal(begin(stopped, { tabId: 7, account: 'b', pace: 'careful', target: null, now: 1_001_000 }).recent.length, 0);
});

test('a run started without the login cookie says what it cannot notice', () => {
  const last = (s) => s.log[s.log.length - 1].text;
  assert.match(last(started()), /login cookie could not be read/);
  assert.equal(last(started({ session: '4242' })), 'Started (careful, all posts).');
  assert.equal(last(started({ session: '4242', target: 5 })), 'Started (careful, 5 posts).');
});

test('a stopped run makes no further request', async () => {
  const ig = fakeInstagram(10);
  const s = halt(started(), 2_000_000, 'user', 'Stopped by you.');
  const again = await step(s, host(ig, () => 3_000_000));
  assert.equal(again, s);
  assert.equal(ig.calls.length, 0);
});

test('a list that does not move on ends the run instead of looping', async () => {
  const id = '3000000000000000001';
  const s0 = { ...started(), recent: [{ id, at: 1_000_000 }] };
  const stuck = { list: async () => ({ ok: true, items: [{ id, code: 'x' }], more: true, next: 'same' }), unsave: async () => assert.fail('no unsave expected') };
  let s = await step(s0, host(stuck, () => s0.nextAt));
  assert.equal(s.cursor, 'same');
  const at = s.nextAt;
  s = await step(s, host(stuck, () => at));
  assert.equal(s.reason.kind, 'error');
});

test('answers from Instagram map to the right stop reason', () => {
  const kinds = [
    [{ ok: false, kind: 'http', statusCode: 400, body: { message: 'feedback_required', spam: true } }, 'blocked'],
    [{ ok: false, kind: 'http', statusCode: 400, body: { message: 'checkpoint_required', checkpoint_url: true } }, 'blocked'],
    [{ ok: false, kind: 'graphql', errors: [{ message: 'x', code: '1404078' }] }, 'blocked'],
    [{ ok: false, kind: 'network', source: { errorMsg: '{"message":"feedback_required"}' } }, 'blocked'],
    [{ ok: false, kind: 'http', statusCode: 401, body: { message: 'Please wait a few minutes before you try again.', require_login: true } }, 'throttled'],
    [{ ok: false, kind: 'http', statusCode: 500, body: null }, 'throttled'],
    // Failed unsaves in the forms Instagram's network layer gave them (observed 2026-11-25).
    [{ ok: false, kind: 'network', statusCode: null, error: { name: 'NetworkRequestError', message: 'Network request encountered error HTTP 500 HTTP_SERVER_ERROR: <!DOCTYPE html>' }, source: { errorType: 'HTTP 500' } }, 'throttled'],
    [{ ok: false, kind: 'network', statusCode: null, error: { name: 'GraphQLError', message: 'GraphQL operation responded with error 1675004: Rate limit exceeded (Operation: PolarisAPIUnsavePostMutation)', code: '1675004' }, source: { message: 'Rate limit exceeded', code: '1675004', severity: 'CRITICAL' } }, 'throttled'],
    [{ ok: false, kind: 'network', statusCode: 401, error: { name: 'NetworkRequestError', message: 'Network request encountered error HTTP 401 HTTP_CLIENT_ERROR: {"message":"Please wait a few minutes before you try again.","require_login":true,"status":"fail"}' }, source: { errorType: 'HTTP 401' } }, 'throttled'],
    [{ ok: false, kind: 'network', statusCode: 0, error: { name: 'NetworkTransportError', message: 'Network request encountered error HTTP HTTP_TRANSPORT_ERROR: ', type: 'warn' }, source: { errorMsg: '', errorType: 'HTTP' } }, 'error'],
    [{ ok: false, kind: 'http', statusCode: 403, body: { message: 'login_required' } }, 'logged-out'],
    [{ ok: false, kind: 'html', detail: '<!DOCTYPE html>' }, 'logged-out'],
    [{ ok: false, kind: 'account-changed' }, 'account'],
    [{ ok: false, kind: 'not-ready', detail: '' }, 'not-ready'],
    [{ ok: false, kind: 'page-changed', detail: 'window.require is missing' }, 'page-changed'],
    [{ ok: false, kind: 'inject', detail: 'No tab with id: 7' }, 'tab'],
    [{ ok: false, kind: 'timeout', detail: 'no answer from Instagram in 75 s' }, 'timeout'],
    // A refusal that came as an ordinary answer in place of the list.
    [{ ok: false, kind: 'unexpected', statusCode: 200, body: { message: 'feedback_required', spam: true }, detail: 'no items list' }, 'blocked'],
    [{ ok: false, kind: 'http', statusCode: 404, body: null, text: '<!DOCTYPE html>' }, 'error'],
  ];
  for (const [res, kind] of kinds) assert.equal(classify(res).kind, kind, JSON.stringify(res));
});
