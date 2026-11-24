// The scheduler. It holds no logic of its own: it stores the run's state, wakes
// on an alarm, and lets the pacing rules decide the one thing to do next, which
// the page function then carries out inside the Instagram tab.
import { begin, freshState, halt, startRefusal, step, classify } from './core.js';
import { pageOp } from './page.js';

const KEY = 'state';
const ALARM = 'step';

async function load() {
  const got = await chrome.storage.local.get(KEY);
  return got[KEY] || freshState();
}

async function save(s) {
  await chrome.storage.local.set({ [KEY]: s });
  const problem = s.status === 'stopped' && !['done', 'limit', 'user'].includes(s.reason.kind);
  await chrome.action.setBadgeBackgroundColor({ color: problem ? '#b3261e' : '#1a6b3c' });
  await chrome.action.setBadgeText({ text: problem ? '!' : s.status === 'running' ? String(s.runCount) : '' });
  return s;
}

// Run pageOp in the tab's own JavaScript world and hand back what it resolved.
async function inPage(tabId, op, arg, account) {
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageOp, args: [op, arg, account || null] });
    return (frame && frame.result) || { ok: false, kind: 'inject', detail: 'The page returned nothing.' };
  } catch (e) {
    return { ok: false, kind: 'inject', detail: String((e && e.message) || e) };
  }
}

function arm(s) {
  return chrome.alarms.create(ALARM, { when: s.nextAt });
}

// Steps never overlap: each waits for the one before it.
let chain = Promise.resolve();
function exclusive(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function tick() {
  let s = await load();
  if (s.status !== 'running') return;
  if (Date.now() < s.nextAt - 500) return arm(s);
  // Should Chrome stop this worker in the middle of a step, this alarm wakes
  // it again; the step's own alarm replaces it on the normal path.
  await chrome.alarms.create(ALARM, { when: Date.now() + 2 * 60 * 1000 });
  s = await step(s, {
    now: Date.now,
    random: Math.random,
    list: (cursor) => inPage(s.tabId, 'list', cursor, s.account),
    unsave: (id) => inPage(s.tabId, 'unsave', id, s.account),
  });
  await save(s);
  if (s.status === 'running') return arm(s);
  await chrome.alarms.clear(ALARM);
  await chrome.tabs.update(s.tabId, { autoDiscardable: true }).catch(() => {});
}

async function onStart({ tabId, pace, target }) {
  const s = await load();
  const refusal = startRefusal(s, Date.now());
  if (refusal) return { ok: false, text: refusal };
  const check = await inPage(tabId, 'check', null);
  if (!check.ok) return { ok: false, text: classify(check).text };
  if (!check.loggedIn) return { ok: false, text: 'Log in to Instagram in this tab first.' };
  if (!check.lister) return { ok: false, text: classify({ kind: 'page-changed', detail: 'PolarisInstapi.apiGet is missing' }).text };
  if (!check.unsaver) return { ok: false, text: classify({ kind: 'not-ready' }).text };
  await save(begin(s, { tabId, account: check.account, pace, target, now: Date.now() }));
  // A sleeping tab cannot be reached, so keep Chrome from discarding this one.
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  exclusive(tick);
  return { ok: true };
}

async function onStop() {
  const s = await load();
  await save(halt(s, Date.now(), 'user', 'Stopped by you.'));
  await chrome.alarms.clear(ALARM);
  if (s.tabId != null) await chrome.tabs.update(s.tabId, { autoDiscardable: true }).catch(() => {});
  return { ok: true };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) exclusive(tick);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const handler = msg && msg.cmd === 'start' ? () => onStart(msg) : msg && msg.cmd === 'stop' ? onStop : null;
  if (!handler) return false;
  exclusive(handler).then(reply, (e) => reply({ ok: false, text: String((e && e.message) || e) }));
  return true;
});

// A run never carries over a Chrome restart: the tab it was bound to is gone.
chrome.runtime.onStartup.addListener(() => {
  exclusive(async () => {
    await save(halt(await load(), Date.now(), 'restart', 'Chrome was restarted. Press Start to continue.'));
    await chrome.alarms.clear(ALARM);
  });
});

// Reloading the extension clears its alarms but not its state; re-arm a run
// that is still marked as running.
exclusive(async () => {
  const s = await load();
  if (s.status === 'running' && !(await chrome.alarms.get(ALARM))) await arm(s);
});
