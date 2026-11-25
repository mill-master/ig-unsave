// The scheduler. It holds no logic of its own: it stores the run's state, wakes
// on an alarm, and lets the pacing rules decide the one thing to do next, which
// the page function then carries out inside the Instagram tab.
import { begin, freshState, halt, startRefusal, step, classify } from './core.js';
import { pageOp } from './page.js';

const KEY = 'state';
const ALARM = 'step';
// The mark of a live run, kept in session storage: true while it runs,
// 'stopping' from the moment Stop is pressed. Chrome empties session storage
// when the browser restarts and when the extension is reloaded or switched
// off, so a run ends with the session its tab belongs to.
const LIVE = 'live';

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

async function live() {
  return (await chrome.storage.session.get(LIVE))[LIVE];
}

// Run pageOp in the tab's own JavaScript world and hand back what it resolved.
// run, when given, is the state of the run the call belongs to.
async function inPage(tabId, op, arg, run) {
  try {
    const [frame] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pageOp, args: [op, arg, (run && run.account) || null, (run && run.session) || null] });
    return (frame && frame.result) || { ok: false, kind: 'inject', detail: 'The page returned nothing.' };
  } catch (e) {
    return { ok: false, kind: 'inject', detail: String((e && e.message) || e) };
  }
}

function arm(s) {
  return chrome.alarms.create(ALARM, { when: s.nextAt });
}

// The end of a run, whatever ended it: no alarm, no mark, and the tab may
// sleep again. The alarm goes first, so that nothing is sent whatever follows.
async function finish(s) {
  await chrome.alarms.clear(ALARM);
  await save(s);
  await chrome.storage.session.remove(LIVE);
  if (s.tabId != null) await chrome.tabs.update(s.tabId, { autoDiscardable: true }).catch(() => {});
}

// What became of a run that is marked as running but is no longer live.
function ended(s, mark) {
  return mark === 'stopping'
    ? halt(s, Date.now(), 'user', 'Stopped by you.')
    : halt(s, Date.now(), 'restart', 'The run ended when Chrome or the extension was restarted. Press Start to continue.');
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
  const mark = await live();
  if (mark !== true) return finish(ended(s, mark));
  if (Date.now() < s.nextAt - 500) return arm(s);
  // Should Chrome stop this worker in the middle of a step, this alarm wakes
  // it again; the step's own alarm replaces it on the normal path.
  await chrome.alarms.create(ALARM, { when: Date.now() + 2 * 60 * 1000 });
  try {
    s = await step(s, {
      now: Date.now,
      random: Math.random,
      persist: (state) => chrome.storage.local.set({ [KEY]: state }),
      list: (cursor) => inPage(s.tabId, 'list', cursor, s),
      unsave: (id) => inPage(s.tabId, 'unsave', id, s),
    });
    await save(s);
  } catch (e) {
    // Nothing unforeseen may leave the alarm set: it would repeat the step.
    await chrome.alarms.clear(ALARM);
    return finish(halt(await load(), Date.now(), 'error', `Stopped on an internal error; nothing more was sent. ${String((e && e.message) || e).slice(0, 200)}`));
  }
  if (s.status !== 'running') return finish(s);
  // When Stop was pressed while the step ran, the alarm stays unset: the Stop
  // itself is next in line.
  if ((await live()) === true) await arm(s);
}

// Settles a run that is marked as running: ended if it is no longer live, and
// given its alarm back should that have gone missing.
async function reconcile() {
  const s = await load();
  if (s.status === 'running') {
    const mark = await live();
    if (mark !== true) await finish(ended(s, mark));
    else if (!(await chrome.alarms.get(ALARM))) await arm(s);
  }
  return { ok: true };
}

async function onStart({ tabId, pace, target }) {
  await reconcile();
  const s = await load();
  const refusal = startRefusal(s, Date.now());
  if (refusal) return { ok: false, text: refusal };
  const check = await inPage(tabId, 'check', null);
  if (!check.ok) return { ok: false, text: classify(check).text };
  if (!check.loggedIn) return { ok: false, text: 'Log in to Instagram in this tab first.' };
  if (check.stale) return { ok: false, text: 'This tab shows one Instagram account while the browser is logged in to another. Reload the tab, check which account it shows, and press Start again.' };
  if (!check.lister) return { ok: false, text: classify({ kind: 'page-changed', detail: 'PolarisInstapi.apiGet is missing' }).text };
  if (!check.unsaver) return { ok: false, text: classify({ kind: 'not-ready' }).text };
  const run = begin(s, { tabId, account: check.account, session: check.session, pace, target, now: Date.now() });
  await chrome.storage.session.set({ [LIVE]: true });
  await save(run);
  // A sleeping tab cannot be reached, so keep Chrome from discarding this one.
  await chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {});
  // The alarm is the lasting trigger; the first step is also taken right away.
  await arm(run);
  exclusive(tick);
  return { ok: true };
}

// Stop takes effect at once, ahead of a step that may still be under way: with
// the alarm cleared and the mark changed, nothing more is sent.
async function stopNow() {
  await chrome.alarms.clear(ALARM);
  if ((await live()) === true) await chrome.storage.session.set({ [LIVE]: 'stopping' });
}

async function onStop() {
  await chrome.alarms.clear(ALARM);
  await finish(halt(await load(), Date.now(), 'user', 'Stopped by you.'));
  return { ok: true };
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM) exclusive(tick);
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  const cmd = msg && msg.cmd;
  const handler = cmd === 'start' ? () => onStart(msg) : cmd === 'stop' ? onStop : cmd === 'sync' ? reconcile : null;
  if (!handler) return false;
  const first = cmd === 'stop' ? stopNow() : Promise.resolve();
  first
    .then(() => exclusive(handler))
    .then(reply, (e) => reply({ ok: false, text: String((e && e.message) || e) }));
  return true;
});

chrome.runtime.onStartup.addListener(() => exclusive(reconcile));
chrome.runtime.onInstalled.addListener(() => exclusive(reconcile));
