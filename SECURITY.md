# Security policy

## Supported versions

Fixes go to the latest `main`. Older commits are not patched.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting on this repository: open the [Security tab](https://github.com/mill-master/ig-unsave/security/advisories/new) and file a draft advisory. That keeps the report private until there is a fix.

Say what you did, what happened, and which commit you were on. A first reply usually takes a few days, since this is a volunteer project.

## What counts

In scope:

- Anything the extension reads or keeps (the ids of the account and login, post ids, the activity log) leaving the computer, or reaching a site other than Instagram.
- A way for a web page or another extension to make this one act: start a run, unsave a post, change the pace, or read its storage.
- A way round the stop rules or the gap between requests.
- Markup or script from a page running in the panel or in the worker.

Out of scope:

- Instagram restricting an account that used the extension. The README says that this can happen.
- Attacks that already need control of the user's Chrome profile or computer.
- Reports from automated scanners with no working path to an impact.
