import { PACES, DAY_MS, freshState } from './core.js';

const $ = (id) => document.getElementById(id);
const KEY = 'state';
let state = freshState();
let stopping = false;

for (const [name, p] of Object.entries(PACES)) {
  const range = p.gapMin === p.gapMax ? '' : `: every ${p.gapMin}–${p.gapMax} s`;
  const option = new Option(`${p.label}${range}, ${p.perDay} a day`, name);
  $('pace').add(option);
}

const clock = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
// A time later today reads as a time; any other day is named.
const when = (t, now) => (new Date(t).toDateString() === new Date(now).toDateString() ? clock(t) : new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }));

function render() {
  const s = state;
  const now = Date.now();
  const running = s.status === 'running';
  const pace = PACES[s.pace];
  const used = s.history.filter((t) => now - t < DAY_MS).length;

  $('status').textContent = running
    ? stopping
      ? 'Stopping, once the request under way is back…'
      : s.waiting === 'daily'
        ? "Waiting: today's allowance is used up"
        : 'Running'
    : s.status === 'stopped'
      ? 'Stopped'
      : 'Idle';
  const problem = s.status === 'stopped' && s.reason;
  $('reason').hidden = !problem;
  $('reason').textContent = problem ? s.reason.text : '';
  $('reason').classList.toggle('reason', !!problem && !['done', 'limit', 'user'].includes(s.reason.kind));

  $('run').textContent = s.target ? `${s.runCount} of ${s.target}` : String(s.runCount);
  $('day').textContent = `${used} of ${pace.perDay}`;
  $('total').textContent = String(s.total);
  $('next').textContent = running && s.nextAt ? (s.nextAt - now > 90000 ? `at ${when(s.nextAt, now)}` : `in ${Math.max(0, Math.round((s.nextAt - now) / 1000))} s`) : '–';

  const locked = !running && s.notBefore && now < s.notBefore;
  $('start').disabled = running || !!locked;
  $('start').textContent = locked ? `Locked until ${new Date(s.notBefore).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : 'Start';
  $('stop').disabled = !running || stopping;
  $('pace').disabled = running;
  $('target').disabled = running;

  $('log').replaceChildren(
    ...s.log
      .slice()
      .reverse()
      .map((line) => {
        const li = document.createElement('li');
        li.textContent = `${clock(line.at)}  ${line.text}`;
        return li;
      }),
  );
}

function say(text) {
  $('message').hidden = !text;
  $('message').textContent = text || '';
}

// What the worker answered, or why no answer came.
const ask = (message) => chrome.runtime.sendMessage(message).catch((e) => ({ ok: false, text: `The extension did not answer: ${(e && e.message) || e}` }));

$('form').addEventListener('submit', async (event) => {
  event.preventDefault();
  say('');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  // The url is visible to this extension only for instagram.com tabs.
  if (!tab || !tab.url || !tab.url.startsWith('https://www.instagram.com/')) {
    return say('Open instagram.com in the current tab, then press Start.');
  }
  const typed = $('target').value.trim();
  const target = typed === '' ? null : Number(typed);
  if (target !== null && !(Number.isInteger(target) && target > 0)) return say('How many posts: a whole number, or empty for all.');
  await chrome.storage.local.set({ prefs: { pace: $('pace').value, target: typed } });
  const answer = await ask({ cmd: 'start', tabId: tab.id, pace: $('pace').value, target });
  if (answer && !answer.ok) say(answer.text);
});

$('stop').addEventListener('click', async () => {
  say('');
  stopping = true;
  render();
  const answer = await ask({ cmd: 'stop' });
  stopping = false;
  if (answer && !answer.ok) say(answer.text);
  render();
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes[KEY]) {
    state = changes[KEY].newValue || freshState();
    render();
  }
});

const stored = await chrome.storage.local.get([KEY, 'prefs']);
state = stored[KEY] || freshState();
// The first run is a small trial unless the count is changed.
const prefs = stored.prefs || { pace: 'careful', target: '5' };
$('pace').value = PACES[prefs.pace] ? prefs.pace : 'careful';
$('target').value = prefs.target;
render();
setInterval(render, 1000);
// A run that Chrome's restart or a reload of the extension ended is shown as ended.
ask({ cmd: 'sync' });
