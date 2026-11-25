// Pacing, limits and stop rules. Pure logic: no browser APIs, so it runs
// unchanged in the service worker and under `node --test`.

// The only two speeds. A step is one request to Instagram, so the gap is also
// the ceiling on request rate. gapMin stays at or above 30 s, the delay Chrome
// imposes on the alarms of a packed extension; step() enforces the gap itself.
export const PACES = {
  careful: { label: 'Careful', gapMin: 30, gapMax: 60, perDay: 1000 },
  slower: { label: 'Slower', gapMin: 60, gapMax: 120, perDay: 250 },
};

export const DAY_MS = 24 * 60 * 60 * 1000;

// How long Start stays locked after Instagram pushes back.
export const COOLDOWN_MS = { throttled: 60 * 60 * 1000, blocked: DAY_MS };

const LOG_LINES = 40;
// Posts unsaved lately are passed over while Instagram's list still shows
// them. The memory is short, so that a post saved again later is not.
const RECENT_IDS = 500;
const RECENT_MS = 60 * 60 * 1000;

export function freshState() {
  return {
    status: 'idle', // idle | running | stopped
    reason: null, // { kind, text, at } once stopped
    waiting: null, // 'daily' while the day's allowance is used up
    tabId: null,
    account: null, // the Instagram account the run was started for
    session: null, // that account's login cookie, when the page can read it
    pace: 'careful',
    target: null, // stop after this many in the run; null means all
    runCount: 0,
    total: 0,
    history: [], // times of successful unsaves in the last 24 h
    queue: [], // posts listed and not yet unsaved: { id, code }
    cursor: null,
    recent: [], // { id, at } of posts unsaved lately, to skip a list that lags behind
    nextAt: null,
    lastAt: null, // when the last request to Instagram was sent
    notBefore: null,
    log: [],
  };
}

export function gapMs(paceName, random) {
  const p = PACES[paceName];
  return Math.round((p.gapMin + random() * (p.gapMax - p.gapMin)) * 1000);
}

function withLog(s, at, text) {
  return { ...s, log: [...s.log, { at, text }].slice(-LOG_LINES) };
}

function stop(s, at, kind, text) {
  const cooldown = COOLDOWN_MS[kind];
  return withLog(
    {
      ...s,
      status: 'stopped',
      reason: { kind, text, at },
      waiting: null,
      queue: [],
      cursor: null,
      nextAt: null,
      notBefore: cooldown ? at + cooldown : s.notBefore,
    },
    at,
    text,
  );
}

// Why Start is refused right now, or null when it may proceed.
export function startRefusal(s, now) {
  if (s.status === 'running') return 'Already running.';
  if (s.notBefore && now < s.notBefore) {
    return `Instagram asked for a pause. Start is locked until ${new Date(s.notBefore).toLocaleString()}.`;
  }
  return null;
}

export function begin(s, { tabId, account, session, pace, target, now }) {
  const paceName = PACES[pace] ? pace : 'careful';
  const count = Number.isInteger(target) && target > 0 ? target : null;
  const unguarded = session ? '' : ' The login cookie could not be read, so a change of account made in another tab will not be noticed.';
  return withLog(
    {
      ...s,
      status: 'running',
      reason: null,
      waiting: null,
      tabId,
      account,
      session: session || null,
      pace: paceName,
      target: count,
      runCount: 0,
      queue: [],
      cursor: null,
      // What another account unsaved says nothing about this one's list.
      recent: account === s.account ? s.recent : [],
      nextAt: now,
      notBefore: null,
    },
    now,
    `Started (${paceName}${count ? `, ${count} posts` : ', all posts'}).${unguarded}`,
  );
}

export function halt(s, now, kind, text) {
  return s.status === 'running' ? stop(s, now, kind, text) : s;
}

// Every string a failed page call carries, lowercased, for the wording tests.
function haystack(res) {
  const parts = [];
  const walk = (v, depth) => {
    if (v == null || depth > 4) return;
    if (typeof v === 'string') parts.push(v);
    else if (typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], depth + 1);
  };
  walk(res, 0);
  return parts.join(' | ').toLowerCase();
}

// 1404006 and 1404078 are the two codes Instagram's own page turns into its
// "Try again later — we restrict certain activity" dialog.
const BLOCK_CODES = new Set(['1404006', '1404078']);

function codesOf(res) {
  const out = [];
  const walk = (v, depth) => {
    if (v == null || typeof v !== 'object' || depth > 4) return;
    for (const k of Object.keys(v)) {
      if ((k === 'code' || k === 'api_error_code') && v[k] != null && typeof v[k] !== 'object') out.push(String(v[k]));
      else walk(v[k], depth + 1);
    }
  };
  walk(res, 0);
  return out;
}

// The HTTP status of a failed call: given outright, or named in the error text
// the way Instagram's network layer writes it ("HTTP 429").
function statusesOf(res, text) {
  return [Number(res.statusCode) || 0, ...[...text.matchAll(/\bhttp (\d{3})\b/g)].map((m) => Number(m[1]))];
}

// Turn a failed page call into a stop reason. Order matters: an activity block
// can arrive on any HTTP status, so it is tested before the status codes.
export function classify(res) {
  const raw = JSON.stringify(res).slice(0, 400);
  if (res.kind === 'not-ready') {
    return {
      kind: 'not-ready',
      text: 'Instagram has not loaded its unsave code in this tab yet. Open any post in the tab (click a saved post so it opens), close it, and press Start again. If that is not enough, unsave that one post by hand with its bookmark icon first.',
    };
  }
  if (res.kind === 'page-changed') {
    return { kind: 'page-changed', text: `Instagram's page code is not what this extension expects, so nothing was sent. Details: ${res.detail || raw}` };
  }
  if (res.kind === 'inject') {
    return { kind: 'tab', text: `The Instagram tab could not be reached (closed, navigated away, or asleep). ${res.detail || ''}`.trim() };
  }
  if (res.kind === 'account-changed') {
    return { kind: 'account', text: 'This browser is no longer logged in to the Instagram account the run was started for (switched or logged out, perhaps in another tab). Nothing was sent.' };
  }
  if (res.kind === 'timeout') {
    return { kind: 'timeout', text: 'Instagram did not answer in time, so the run stopped. If the request was an unsave, that post may or may not have been unsaved.' };
  }
  if (res.kind === 'html') {
    return { kind: 'logged-out', text: 'Instagram answered with a web page instead of the saved list, which usually means this tab is no longer logged in. Log in and press Start again.' };
  }
  const text = haystack(res);
  const statuses = statusesOf(res, text);
  const body = res.body || {};
  if (
    /feedback_required|checkpoint_required|challenge_required|restrict certain activity|try again later|action blocked/.test(text) ||
    codesOf(res).some((c) => BLOCK_CODES.has(c)) ||
    body.checkpoint_url ||
    body.spam === true
  ) {
    return { kind: 'blocked', text: `Instagram restricted this activity or wants a verification. Stopped, and Start is locked for a while. Open Instagram and follow what it shows. Details: ${raw}` };
  }
  if (statuses.some((n) => n === 429 || (n >= 500 && n <= 599)) || /wait a few minutes|rate limit|too many requests/.test(text)) {
    return { kind: 'throttled', text: `Instagram asked to slow down (or shows you as logged out). Stopped, and Start is locked for a while. Consider the slower pace next time. Details: ${raw}` };
  }
  if (statuses.some((n) => n === 401 || n === 403) || body.require_login === true || /login_required|not logged in/.test(text)) {
    return { kind: 'logged-out', text: 'Instagram says this tab is not logged in. Log in and press Start again.' };
  }
  return { kind: 'error', text: `Stopped on an answer this extension does not recognise. Nothing more was sent. Details: ${raw}` };
}

// One step of a run: at most one request to Instagram. deps supplies the clock,
// the random source, the store and the two page calls, so tests can fake them.
export async function step(state, deps) {
  if (state.status !== 'running') return state;
  const now = deps.now();
  const pace = PACES[state.pace];
  const recent = (state.recent || []).filter((r) => r && typeof r === 'object' && now - r.at < RECENT_MS);
  let s = { ...state, waiting: null, history: state.history.filter((t) => now - t < DAY_MS), recent };
  const after = () => deps.now() + gapMs(s.pace, deps.random);

  if (s.history.length >= pace.perDay) {
    const resume = s.history[0] + DAY_MS + gapMs(s.pace, deps.random);
    return { ...s, waiting: 'daily', nextAt: resume };
  }

  // However this step came about (Start pressed again, a reload, an alarm
  // firing early), no request leaves sooner than the minimum gap after the one
  // before it.
  const earliest = (s.lastAt || 0) + pace.gapMin * 1000;
  if (now < earliest) return { ...s, nextAt: earliest };

  // Stored before sending, so the time of this request outlives a worker that
  // is stopped while the request is under way.
  s = { ...s, lastAt: now };
  await deps.persist(s);

  if (s.queue.length === 0) {
    const res = await deps.list(s.cursor);
    const at = deps.now();
    if (!res.ok) {
      const c = classify(res);
      return stop(s, at, c.kind, c.text);
    }
    const lately = new Set(s.recent.map((r) => r.id));
    const todo = res.items.filter((it) => !lately.has(it.id));
    const passed = res.items.length - todo.length;
    if (todo.length > 0) {
      return withLog({ ...s, queue: todo, cursor: null, nextAt: after() }, at, `Instagram listed ${todo.length} saved post${todo.length === 1 ? '' : 's'}.`);
    }
    if (!res.more) {
      if (passed > 0) return stop(s, at, 'done', `Done: Instagram lists nothing but ${passed} post${passed === 1 ? '' : 's'} that this extension unsaved a short while ago.`);
      return stop(s, at, 'done', s.total > 0 ? 'Done: no saved posts are left.' : 'Instagram lists no saved posts.');
    }
    if (!res.next || res.next === s.cursor) {
      return stop(s, at, 'error', "Stopped: Instagram's list did not move on to the next page.");
    }
    return { ...s, cursor: res.next, nextAt: after() };
  }

  const item = s.queue[0];
  const res = await deps.unsave(item.id);
  const at = deps.now();
  if (!res.ok) {
    const c = classify(res);
    // A refusal that cannot be read may belong to this one post, which the
    // next run would meet first again.
    const which = c.kind === 'error' && item.code ? ` It happened on instagram.com/p/${item.code}. If that post stops the run again, unsave it by hand.` : '';
    return stop(s, at, c.kind, c.text + which);
  }
  s = withLog(
    {
      ...s,
      queue: s.queue.slice(1),
      runCount: s.runCount + 1,
      total: s.total + 1,
      history: [...s.history, at],
      recent: [...s.recent, { id: item.id, at }].slice(-RECENT_IDS),
    },
    at,
    `Unsaved ${item.code ? `instagram.com/p/${item.code}` : item.id}.`,
  );
  if (s.target && s.runCount >= s.target) {
    return stop(s, at, 'limit', `Done: unsaved the ${s.target} post${s.target === 1 ? '' : 's'} asked for.`);
  }
  return { ...s, nextAt: after() };
}
