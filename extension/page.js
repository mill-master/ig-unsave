// The one function this extension ever runs inside the Instagram tab. Chrome
// serialises it and executes it in the page's own JavaScript world, so it must
// stay self-contained: nothing outside its body exists when it runs.
//
// It sends nothing to Instagram by itself. It asks Instagram's page code to do
// the work: the list is read with the page's own REST helper, and a post is
// unsaved by committing the page's own unsave mutation on the page's own
// connection. Every request is therefore built, signed and sent by Instagram's
// code, with whatever identifiers the running build of the site uses.
//
// op 'check'  -> { ok, loggedIn, account, session, lister, unsaver }  (no request)
// op 'list'   -> { ok, items: [{ id, code }], more, next }            (one GET)
// op 'unsave' -> { ok }                                               (one mutation)
// A failure is { ok: false, kind, ... } carrying whatever Instagram answered.
// account and session, when given, name the login the run was started for: the
// page's own record of the user, and the browser's login cookie. list and
// unsave refuse to act once either has changed.
export function pageOp(op, arg, account, session) {
  // Longer than the 60 s Instagram's own code allows a request, so a timeout
  // here never leaves that request still under way.
  const TIMEOUT_MS = 75000;
  // Modules that can hold the unsave mutation, the one read first-hand from
  // Instagram's code first. Whichever is found must still pass isUnsave below.
  const UNSAVE_MODULES = ['PolarisAPIUnsavePostMutation.graphql', 'usePolarisSaveMediaUnsaveMutation.graphql'];

  const req = window.require;
  const get = (name) => {
    try {
      const m = req(name);
      return m == null ? null : m;
    } catch (e) {
      return null;
    }
  };
  const flat = (e) => {
    if (e == null || typeof e !== 'object') return e == null ? null : String(e).slice(0, 300);
    const out = {};
    for (const k of ['name', 'message', 'code', 'api_error_code', 'severity', 'summary', 'description', 'errorSummary', 'errorDescription', 'errorMsg', 'statusCode', 'status', 'errorType', 'type']) {
      const v = e[k];
      if (v != null && typeof v !== 'object' && typeof v !== 'function') out[k] = String(v).slice(0, 300);
    }
    return out;
  };
  // A Relay mutation whose single variable is `input` and whose root field is
  // xig_media_unsave. Anything else is refused, never guessed at.
  const isUnsave = (a) => {
    try {
      const o = a.operation;
      return (
        a.kind === 'Request' &&
        a.params.operationKind === 'mutation' &&
        typeof a.params.id === 'string' &&
        o.argumentDefinitions.length === 1 &&
        o.argumentDefinitions[0].name === 'input' &&
        o.selections.length === 1 &&
        o.selections[0].name === 'xig_media_unsave'
      );
    } catch (e) {
      return false;
    }
  };
  const findUnsave = () => {
    for (const name of UNSAVE_MODULES) {
      const m = get(name);
      const a = m && (m.default || m);
      if (a && isUnsave(a)) return { name, artifact: a };
    }
    return null;
  };
  // Named in the failure text when the mutation is missing, to make a change
  // on Instagram's side quick to diagnose.
  const loadedLike = (re) => {
    const dbg = get('__debug');
    const map = dbg && dbg.modulesMap;
    return map ? Object.keys(map).filter((n) => re.test(n)).slice(0, 12) : [];
  };

  if (typeof req !== 'function') {
    return Promise.resolve({ ok: false, kind: 'page-changed', detail: 'window.require is missing' });
  }
  const api = get('PolarisInstapi');
  const lister = !!(api && typeof api.apiGet === 'function');

  const user = get('CurrentUserInitialData') || {};
  const uid = String(user.NON_FACEBOOK_USER_ID || user.USER_ID || '0');
  // The login cookie is shared by every tab, so it follows an account switch
  // made in another tab, which this tab's own record of the user does not.
  const login = (document.cookie.match(/(?:^|; )ds_user_id=(\d+)/) || [])[1] || null;

  if (op === 'check') {
    const found = findUnsave();
    return Promise.resolve({ ok: true, loggedIn: uid !== '0', account: uid, session: login, lister, unsaver: found ? found.name : null });
  }
  if ((account && uid !== account) || (session && login !== session)) return Promise.resolve({ ok: false, kind: 'account-changed' });

  // work never rejects: every branch below resolves to a result object.
  const withTimeout = (work) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, kind: 'timeout', detail: `no answer from Instagram in ${TIMEOUT_MS / 1000} s` }), TIMEOUT_MS);
      work.then((result) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

  if (op === 'list') {
    if (!lister) return Promise.resolve({ ok: false, kind: 'page-changed', detail: 'PolarisInstapi.apiGet is missing' });
    const work = api.apiGet('/api/v1/feed/saved/posts/', { query: arg ? { max_id: arg } : {} }).then(
      (res) => {
        const data = res && res.data;
        // A logged-out tab is redirected to the login page. The helper hands
        // that text back spread into an object of single characters.
        if (typeof data === 'string') return { ok: false, kind: 'html', detail: data.slice(0, 80) };
        if (data && typeof data[0] === 'string' && !Array.isArray(data.items)) {
          let head = '';
          for (let i = 0; i < 80 && typeof data[i] === 'string'; i += 1) head += data[i];
          return { ok: false, kind: 'html', detail: head };
        }
        if (!data || !Array.isArray(data.items)) {
          return { ok: false, kind: 'unexpected', statusCode: res && res.statusCode, detail: `no items list; fields: ${Object.keys(data || {}).slice(0, 12).join(',')}` };
        }
        const items = [];
        for (const it of data.items) {
          const m = (it && it.media) || it || {};
          // The numeric id sits before the underscore of "id". "pk" is used
          // only when it is exact: as a JSON number it is too large to be.
          let id = typeof m.id === 'string' ? m.id.split('_')[0] : '';
          if (!id && (typeof m.pk === 'string' || Number.isSafeInteger(m.pk))) id = String(m.pk);
          if (!/^\d{5,}$/.test(id)) return { ok: false, kind: 'unexpected', detail: `a listed post has no usable id; fields: ${Object.keys(m).slice(0, 12).join(',')}` };
          items.push({ id, code: typeof m.code === 'string' ? m.code : '' });
        }
        const cursor = data.next_max_id;
        if (typeof cursor === 'number' && !Number.isSafeInteger(cursor)) return { ok: false, kind: 'unexpected', detail: 'the paging cursor is a number too large to read exactly' };
        return { ok: true, items, more: data.more_available === true, next: cursor == null ? null : String(cursor) };
      },
      (e) => ({
        ok: false,
        kind: 'http',
        statusCode: e && e.statusCode,
        error: flat(e),
        body: e && e.responseObject && typeof e.responseObject === 'object' ? { ...flat(e.responseObject), require_login: e.responseObject.require_login === true, spam: e.responseObject.spam === true, checkpoint_url: !!e.responseObject.checkpoint_url, feedback_title: String(e.responseObject.feedback_title || '').slice(0, 120) } : null,
        text: typeof (e && e.responseText) === 'string' ? e.responseText.slice(0, 200) : '',
      }),
    );
    return withTimeout(work);
  }

  if (op === 'unsave') {
    if (!/^\d{5,}$/.test(String(arg))) return Promise.resolve({ ok: false, kind: 'exception', detail: 'not a media id' });
    const found = findUnsave();
    if (!found) {
      return Promise.resolve({ ok: false, kind: 'not-ready', detail: `unsave mutation not loaded; loaded modules that mention it: ${loadedLike(/unsave/i).join(', ') || 'none'}` });
    }
    const relay = get('CometRelay');
    const envModule = get('PolarisRelayEnvironment');
    const environment = envModule && (envModule.default || envModule);
    if (!relay || typeof relay.commitMutation !== 'function' || !environment) {
      return Promise.resolve({ ok: false, kind: 'page-changed', detail: 'CometRelay.commitMutation or PolarisRelayEnvironment is missing' });
    }
    const work = new Promise((resolve) => {
      try {
        relay.commitMutation(environment, {
          mutation: found.artifact,
          variables: { input: { media_id: String(arg) } },
          onCompleted: (response, errors) => {
            if (errors && errors.length) return resolve({ ok: false, kind: 'graphql', errors: errors.slice(0, 3).map(flat) });
            if (!response || response.xig_media_unsave == null) return resolve({ ok: false, kind: 'unexpected', detail: `no xig_media_unsave in the answer; fields: ${Object.keys(response || {}).slice(0, 12).join(',')}` });
            resolve({ ok: true });
          },
          onError: (e) => {
            const source = e && e.source;
            // Where Instagram's network layer puts the status of an HTTP failure.
            const status = source && source.errorRawTransportStatus;
            resolve({ ok: false, kind: 'network', statusCode: typeof status === 'number' ? status : null, error: flat(e), source: flat(source) });
          },
        });
      } catch (e) {
        resolve({ ok: false, kind: 'exception', detail: String(e && e.message).slice(0, 300) });
      }
    });
    return withTimeout(work);
  }

  return Promise.resolve({ ok: false, kind: 'exception', detail: `unknown op ${op}` });
}
