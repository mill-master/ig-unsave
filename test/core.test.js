import test from 'node:test';
import assert from 'node:assert/strict';
import { PACES, DAY_MS, COOLDOWN_MS, begin, classify, freshState, gapMs, halt, startRefusal, step } from '../extension/core.js';

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

// Drive a run the way the alarm does: jump the clock to each due time.
async function run(state, ig, { maxSteps = 2000, random = () => 0.5 } = {}) {
  let now = state.nextAt;
  const times = [];
  let s = state;
  for (let i = 0; i < maxSteps && s.status === 'running'; i += 1) {
    const before = ig.calls.length;
    s = await step(s, { now: () => now, random, list: ig.list, unsave: ig.unsave });
    const made = ig.calls.length - before;
    assert.ok(made <= 1, 'a step makes at most one request');
    if (made === 1) times.push(now);
    if (s.status === 'running') now = s.nextAt;
  }
  return { s, times, now };
}

const started = (over = {}) => begin(freshState(), { tabId: 7, pace: 'careful', target: null, now: 1_000_000, ...over });

test('every pace keeps at least 30 s between requests', () => {
  for (const name of Object.keys(PACES)) {
    assert.ok(PACES[name].gapMin >= 30, `${name} gapMin`);
    assert.equal(gapMs(name, () => 0), PACES[name].gapMin * 1000);
    assert.ok(gapMs(name, () => 0.999999) <= PACES[name].gapMax * 1000);
  }
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

test('the daily allowance pauses the run until the oldest unsave is a day old', async () => {
  const ig = fakeInstagram(PACES.careful.perDay + 3);
  let s = started();
  let now = s.nextAt;
  while (s.status === 'running' && !s.waiting) {
    s = await step(s, { now: () => now, random: () => 0, list: ig.list, unsave: ig.unsave });
    if (s.status === 'running' && !s.waiting) now = s.nextAt;
  }
  assert.equal(s.waiting, 'daily');
  assert.equal(ig.removed.length, PACES.careful.perDay);
  assert.ok(s.nextAt >= s.history[0] + DAY_MS, 'resumes no earlier than a day after the oldest');
  const before = ig.calls.length;
  s = await step(s, { now: () => now + 60_000, random: () => 0, list: ig.list, unsave: ig.unsave });
  assert.equal(ig.calls.length, before, 'no request while waiting');
  const resumed = await run({ ...s, nextAt: s.nextAt }, ig);
  assert.equal(resumed.s.reason.kind, 'done');
  assert.equal(ig.left(), 0);
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

test('a stopped run makes no further request', async () => {
  const ig = fakeInstagram(10);
  const s = halt(started(), 2_000_000, 'user', 'Stopped by you.');
  const again = await step(s, { now: () => 3_000_000, random: () => 0, list: ig.list, unsave: ig.unsave });
  assert.equal(again, s);
  assert.equal(ig.calls.length, 0);
});

test('a list that does not move on ends the run instead of looping', async () => {
  const id = '3000000000000000001';
  const s0 = { ...started(), recent: [id] };
  const list = async () => ({ ok: true, items: [{ id, code: 'x' }], more: true, next: 'same' });
  let s = await step(s0, { now: () => s0.nextAt, random: () => 0, list, unsave: async () => assert.fail('no unsave expected') });
  assert.equal(s.cursor, 'same');
  s = await step(s, { now: () => s.nextAt, random: () => 0, list, unsave: async () => assert.fail('no unsave expected') });
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
    [{ ok: false, kind: 'http', statusCode: 403, body: { message: 'login_required' } }, 'logged-out'],
    [{ ok: false, kind: 'html', detail: '<!DOCTYPE html>' }, 'logged-out'],
    [{ ok: false, kind: 'not-ready', detail: '' }, 'not-ready'],
    [{ ok: false, kind: 'page-changed', detail: 'window.require is missing' }, 'page-changed'],
    [{ ok: false, kind: 'inject', detail: 'No tab with id: 7' }, 'tab'],
    [{ ok: false, kind: 'timeout', detail: 'no answer from Instagram in 45 s' }, 'error'],
    [{ ok: false, kind: 'http', statusCode: 404, body: null, text: '<!DOCTYPE html>' }, 'error'],
  ];
  for (const [res, kind] of kinds) assert.equal(classify(res).kind, kind, JSON.stringify(res));
});
