# IG Unsave

IG Unsave clears your saved posts on Instagram for you, slowly, from your own Chrome. It works through the list newest first and unsaves one post at a time, with a pause between requests that you choose: 30 to 60 seconds unless you change it. It stops by itself when Instagram throttles or refuses a request.

It is a small Chrome extension that you load from a folder. It has no server, no account, no analytics and no third-party code, and you can read all of it in one sitting.

## What you get

- Your saved posts cleared without clicking through them: all of them, or the newest few as a trial.
- A slow, steady pace. At the default pace a thousand posts take about half a day of running. The figures are under [What to expect](#what-to-expect).
- A stop at the first throttle, restriction or answer it does not understand. After a throttle or a restriction the Start button is greyed out for a while, so that Instagram is not asked again too soon.
- Instagram's own page code builds and sends every request, so the extension holds no copy of a request that could go stale when the site changes.
- Nothing sent anywhere but Instagram. The extension itself is barred from the network: only Instagram's page talks to Instagram.
- A plain account of what has been tried, which is 1,000 unsaves in a day on one real account. See [What has been checked](#what-has-been-checked).

## Before you use it

- **Unsaving cannot be undone.** Expect an unsaved post to leave every collection it was in as well. That is how Instagram treats an unsave, though it was not tested separately here.
- It clears everything in "All posts", the list that holds every post you have saved, newest first. It cannot keep some posts or work on a single collection. A post you want to keep has to be saved again afterwards.
- Automating an account is against Instagram's terms of use, whatever the pace. Going slowly lowers the risk of a restriction and does not remove it. You use this on your own account, at your own risk. What has been tried on a real account, and what has not, is set out under [What has been checked](#what-has-been-checked).
- If you use more than one Instagram account in this browser, reload the Instagram tab before you press Start. A tab left open from before a change of account still shows the old one.
- This project is not affiliated with Instagram or Meta.

## Requirements

- Chrome 120 or later on a desktop computer.
- An Instagram account that you are logged in to at instagram.com.

## Quick start

### 1. Get the code

Clone the repository, or use **Code → Download ZIP** on GitHub and unpack it.

```sh
git clone https://github.com/mill-master/ig-unsave.git
```

### 2. Load it into Chrome

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Choose **Load unpacked** and select the `extension` folder.
3. Pin "IG Unsave" from the puzzle-piece menu. It has no icon of its own, so Chrome shows a letter.

### 3. Run a trial

1. Open instagram.com and log in to the account whose saved posts should go.
2. Open any saved post once, then close it. Instagram loads its unsave code only when a post is shown, and the extension uses that code.
3. With that tab in front, click the IG Unsave icon, which opens a small panel. Its "How many posts" field starts at 5. Press **Start**.
4. A few minutes later, reload your Saved page and check that those posts are gone.

### 4. Clear the rest

Empty the "How many posts" field and press **Start** again. Keep the Instagram tab open and the computer awake. The panel can be closed.

## What to expect

A run is one pass from Start until the list is empty, something stops it, or you press Stop. The pace is chosen in the panel: Careful, which is the default, Slower, or a fixed gap of 10, 20, 30, 40, 50 or 60 seconds.

At Careful it sends one request every 30 to 60 seconds. That is about 80 requests an hour, nearly all of them unsaves (the rest fetch the list), so a thousand posts take some 13 hours of running. The most tried on a real account is 1,000 in a day, as [What has been checked](#what-has-been-checked) sets out. Slower takes twice as long between requests. A gap shorter than 30 seconds is faster than anything tried on a real account: the chance of a throttle or a restriction is higher, by how much nobody can say. The panel shows the values in force.

- The number on the extension's icon counts the posts unsaved in this run. A red `!` there means the run stopped on a problem: open the panel to read why.
- If the computer sleeps, the run pauses. On waking it carries on, or stops with a message if the connection is not back yet.
- A run belongs to the tab and the account it was started for. It stops if the tab is closed, or if the browser's Instagram login changes, even in another tab.
- Stop takes effect at once: nothing more is sent. If a request is under way, the panel shows the run as stopped once that request is back.
- A run ends when Chrome restarts, or when the extension is reloaded or switched off. Press Start to carry on.

## When it stops

The panel says why. The usual cases:

| The panel says | What happened | What to do |
| --- | --- | --- |
| Instagram asked to slow down | A throttle, a server error, or Instagram answering as if you were logged out. Start is locked for an hour: the button is greyed out and says when it unlocks. | Wait. Choose Slower next time. |
| Instagram restricted this activity or wants a verification | A restriction, or a demand to confirm who you are. Start is locked for a day. | Open Instagram and follow what it shows. Give the account a rest. |
| Instagram has not loaded its unsave code | The tab was reloaded, or no post has been opened in it yet. | Open any post in the tab, close it, and press Start. |
| This browser is no longer logged in to the account | You switched account or logged out during the run, perhaps in another tab. | Log in to the right account and press Start. |
| This tab shows one Instagram account while the browser is logged in to another | The tab was already open when you switched account. | Reload the tab, check which account it shows, and press Start. |
| Instagram did not answer in time | A request got no answer in time. The extension does not send it again. | Look at your Saved page to see whether the newest post is still there, then press Start. |
| The run ended when Chrome or the extension was restarted | A run does not outlive the browser session. | Press Start. |
| Instagram's page code is not what this extension expects | Instagram changed its site. Nothing was sent. | Look for a newer version here, or open an issue with the message. |
| An answer this extension does not recognise | Nothing more was sent. The message names the post if one was involved. | If the same post stops the run twice, unsave it by hand. Otherwise open an issue and paste the message. |

## How it works

There are three parts, each short.

- **The panel** (`popup.*`) shows the state of the run and has Start and Stop.
- **The background worker** (`background.js`) wakes on an alarm, takes one step and goes back to sleep. What a step may do is decided in `core.js`: the gap and the reasons to stop. That file is pure logic and has unit tests.
- **One function** (`page.js`) is run inside the Instagram tab for each step. It sends nothing itself. It asks Instagram's own page code to fetch the saved list or to unsave one post, after checking that the code it found is the unsave operation and nothing else.

Because Instagram's code builds each request, the request carries the query identifiers of the version of the site that is running. A widely used downloader that sends its own copy of a request was refused by Instagram (`feedback_required`) until the query identifier inside that copy was changed ([instaloader issue 2744](https://github.com/instaloader/instaloader/issues/2744)). When Instagram changes something this extension relies on, the extension stops and says what it could not find.

## How it avoids rate limits

Instagram publishes no limits, so nobody outside it knows what pace is safe. The pace here is a judgement, made from the few public reports that could be found and from one real run.

What the reports say (read in November 2026):

- An add-on that unsaves a post every 80 to 250 milliseconds has one review saying that Instagram restricted the account for a month, and another saying that the account was banned ([its reviews](https://addons.mozilla.org/en-US/firefox/addon/instaunsave-turbo/reviews/)). These are users' own accounts of what happened, not statements from Instagram.
- A script for bulk unliking says that Instagram throttles it after a burst of some 100 to 150 actions in a short run ([its README](https://github.com/dodosack/instagram-activity-cleaner)).

Both point at bursts. So the extension spaces its requests widely, at about 80 an hour at the default pace, where that add-on sends several a second. Slower sends about half as many.

Beyond the pace, it treats any pushback as a reason to stop:

- One request at a time. Pressing Stop and then Start does not shorten the gap.
- A throttle or a server error ends the run and locks Start for an hour. A restriction or a demand for verification locks it for a day. Both periods are this extension's own choice, not Instagram's.
- An answer it does not recognise also ends the run, with Instagram's answer shown in the panel.

## Privacy and security

- Permissions: `scripting`, `storage`, `alarms`, and access to `www.instagram.com` only.
- The panel and the background worker cannot open a network connection: the content security policy in the manifest forbids it, and the code calls no browser API that loads a URL. The one function run in Instagram's page sends nothing itself. It asks Instagram's code to send the list and unsave requests, and those go to Instagram.
- Nothing is injected into Instagram until you press Start. What runs in the page then is the one function in `extension/page.js`.
- There are no dependencies and no build step.

It keeps the following in Chrome's local extension storage, on your computer, until you remove the extension:

- the state of the run, and your pace and count settings;
- the ids of the account and of the browser's Instagram session that the run belongs to;
- the ids of the posts waiting to be unsaved, and of those unsaved a short while ago;
- the latest lines of the activity log, which hold the addresses of unsaved posts and Instagram's error messages.

To report a security problem, see [SECURITY.md](SECURITY.md).

## Limitations

- There is no filter by collection, date or author.
- It runs one job at a time, in one tab.
- It cannot say how many saved posts are left, because Instagram's list gives no total.
- The locks on Start are kept with the extension as installed in one Chrome profile. Removing it, or loading it from another folder or in another profile, clears them.
- If Chrome stops the extension's worker in the middle of a request, that request is sent once more two minutes later. It is the one case in which a request is repeated.
- Instagram changes its site often, so this will need an update now and then.

## What has been checked

As of 25 November 2026.

On a real account, one account on one day: 500 posts unsaved at the Careful pace, with no throttle and no restriction from Instagram. By the end of that day the count had reached 1,000.

Not tried on a real account: a gap shorter than 30 seconds, more than 1,000 unsaves in a day, more than one day of use, and a real throttle or restriction. How the extension reacts to those rests on the tests below, in which Instagram's answers were made up.

Tested without a real account:

- **Against Instagram's live page code**, on a public post page, logged out. The function in `page.js` found Instagram's unsave operation, refused anything else, and made the page build its own request. In place of Instagram's answer it was then given made-up ones: a success, HTTP 429, 500 and 401, a rate-limit error, a `feedback_required` refusal and a dropped connection. Each came back in a form the stop rules read correctly. The made-up answers were given inside the browser, so nothing reached Instagram.
- **The whole extension, in Chromium 156**, against a local page that imitates the parts of Instagram the extension uses. This covered the refusals when logged out or when the unsave code is not loaded, runs at the default pace and at the 10 and 20 second gaps, the gap kept when Stop is followed at once by Start, the stop when the login changes to another account, Stop pressed during a request that never comes back, a run ending on a restart, and the ban on network access for the panel and the worker.
- **The pacing and stop rules**, by the unit tests in `test/`.

## Uninstall

Press Stop, remove IG Unsave on `chrome://extensions`, and delete the folder.

## Development

The extension has no build step. The files under `extension/` are what Chrome loads.

```sh
npm test    # Node 20 or later, no dependencies
```

After editing a file, press the reload arrow on the extension's card in `chrome://extensions`. The panel reads new files at once, but the worker keeps the old ones until then.

## Licence

MIT. See [LICENSE](LICENSE).
