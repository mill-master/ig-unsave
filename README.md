# Unsave saved Instagram posts in bulk, slowly, with nothing leaving your browser

A Chrome extension for your own use. It works through your saved posts, newest first, and unsaves them one request at a time with tens of seconds between requests and a daily allowance. It stops by itself the moment Instagram pushes back.

It has no server, no analytics and no third-party code. The whole thing is a few short plain JavaScript files you can read in one sitting.

## Install

1. Open `chrome://extensions` and switch on Developer mode.
2. Choose Load unpacked and select the `extension` folder.

Chrome 120 or later.

## Use

1. Open instagram.com in a tab and log in to the account whose saved posts should go.
2. Open any post in that tab once (click a saved post so it opens, then close it). Instagram loads its unsave code only when a post is shown, and the extension uses that code.
3. Click the extension's icon, choose a pace and how many posts, and press Start.

The first run is set to a handful of posts. Check on Instagram that they are gone, then clear the count to unsave everything.

Keep the Instagram tab open while a run is going; the panel can be closed. A run is tied to the tab and the account it was started for, and stops if the browser's Instagram login changes, even in another tab. It does not carry over a Chrome restart: press Start again.

Unsaving a post also removes it from every collection it was in, and it cannot be undone.

## How it avoids being rate limited

Instagram publishes no limits, and the reports that exist (collected 2026-11-25) are few. Tools that unsave several posts a second have had accounts restricted for weeks; bulk unliking has drawn "try again later" after a hundred or so actions within minutes. So the extension stays far below that, and treats any pushback as a reason to stop, never to retry:

- One request at a time. The gap between requests and the daily allowance are the `PACES` table in `extension/core.js`; the panel shows their values. No request leaves sooner than the minimum gap after the one before it, whether the run went on by itself or Start was pressed again.
- A throttle answer, a server error, an activity restriction or a request for verification ends the run and locks Start for a cooling-off period, longer after a restriction than after a throttle (`COOLDOWN_MS` in the same file).
- An answer it does not recognise also ends the run, with Instagram's answer shown in the panel.

The requests themselves are not built by the extension. It asks Instagram's own page code to fetch the saved list and to unsave a post, so each request is the one the site would send for a click, with the identifiers of whatever version of the site is running. Tools that send their own copy of a request with an outdated identifier have been flagged for it.

The daily count and the locks are kept with the installed copy of the extension. Removing it, or loading it from another folder or in another Chrome profile, starts them from zero. After editing the files, press the reload arrow on the extension's card in `chrome://extensions`: the panel reads the new files at once, but a run keeps following the old ones until then.

Automating an account is against Instagram's terms of use whatever the pace. A slow pace lowers the risk; it does not remove it.

## Privacy

- Permissions: `scripting`, `storage`, `alarms`, and access to `www.instagram.com` only.
- The extension's own code cannot open a network connection at all: the manifest's content security policy forbids it.
- Nothing is injected into Instagram until Start is pressed. What runs in the page then is the one function in `extension/page.js`.
- It stores, in Chrome's local extension storage on your computer: the run's counters and timestamps, the ids of the account and login the run belongs to, the ids of the posts on the page being worked through, and the activity log.

## What has been checked, and what has not

Checked on 2026-11-25:

- A run on a logged-in account, as its owner reported it: 500 posts unsaved in one day at one request every 30 to 60 seconds, with no throttle or restriction from Instagram.
- The page function, against Instagram's live client code on a public post page without logging in. It finds the page's unsave mutation, refuses anything that is not that mutation, and makes the page build its native request. Fed fabricated answers in place of Instagram's (a success, HTTP 429, 500 and 401, a rate-limit error, a `feedback_required` refusal, a dropped connection), it reports each in a form the stop rules read correctly. Those requests were answered inside the browser, so nothing was unsaved and nothing reached Instagram's API.
- The whole extension in Chromium 156 against a local stand-in for Instagram: refusals when logged out or when the unsave code is not loaded, a run of list and unsave requests at the set pace, the minimum gap kept when Stop is followed at once by Start, the stop when the login cookie changes to another account, and the network ban on the extension's own code.
- The pacing and stop rules, by the unit tests.

Not checked on a real account: more than 500 unsaves in a day, more than one day of use, and a real throttle or restriction, whose handling rests on the fabricated answers above.

Instagram changes its page code often. When it changes something this relies on, the extension sends nothing and says what it could not find.

## Tests

```
npm test
```
