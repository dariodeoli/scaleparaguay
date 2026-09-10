import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {runInNewContext} from 'node:vm';
import test from 'node:test';

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');
const script = readFileSync(new URL('assets/tracking/live-visitors.js', root), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// Execute the shipped JS, with no browser and no access to real fetch/network.
// Cookie jars and locks are shared across tabs only when their origins match.
function browser({blockedCookies = false, throwingCookies = false, locks = true, crypto = true} = {}) {
  let now = 10000000, status = 202, failure = '', serial = 0;
  const jars = new Map(), heldLocks = new Set(), requests = [], tabs = [];
  const clock = class extends Date {static now() {return now;}};
  function tab({origin = 'https://scaleparaguay.com', path = '/', visible = true, frame = false} = {}) {
    const intervals = new Map(), timeouts = new Map(), docListeners = new Map(), winListeners = new Map();
    const document = {
      visibilityState: visible ? 'visible' : 'hidden',
      get cookie() {
        if (throwingCookies) throw new Error('Cookie access blocked');
        const saved = jars.get(origin);
        return !blockedCookies && saved?.expires > now ? saved.value : '';
      },
      set cookie(value) {
        if (throwingCookies) throw new Error('Cookie access blocked');
        assert(value.endsWith('; Max-Age=90; Path=/; Secure; SameSite=Strict'));
        assert(!value.includes('Domain='));
        if (!blockedCookies) jars.set(origin, {value: value.split(';')[0], expires: now + 90000});
      },
      addEventListener: (event, fn) => docListeners.set(event, fn)
    };
    const window = {addEventListener: (event, fn) => winListeners.set(event, fn)};
    window.top = frame ? {} : window;
    const context = {
      window, document, location: {origin, pathname: path}, Date: clock, AbortController,
      crypto: crypto ? {randomUUID} : {},
      navigator: {locks: locks ? {request: async (name, options, fn) => {
        assert.equal(name, 'scale-live-visitors-v1');assert.equal(options.ifAvailable, true);
        const key = origin + ':' + name;
        if (heldLocks.has(key)) return fn(null);
        heldLocks.add(key);
        try {return fn({});} finally {heldLocks.delete(key);}
      }} : undefined},
      setInterval: (fn, ms) => {assert.equal(ms, 30000);intervals.set(++serial, fn);return serial;},
      clearInterval: id => intervals.delete(id),
      setTimeout: (fn, ms) => {assert.equal(ms, 8000);timeouts.set(++serial, fn);return serial;},
      clearTimeout: id => timeouts.delete(id),
      fetch: async (url, init) => {
        assert.equal(url, 'https://admin.scaleparaguay.com/api/public/live-visitors/heartbeat');
        assert.equal(document.visibilityState, 'visible');
        assert.equal(init.method, 'POST');assert.equal(init.credentials, 'omit');assert.equal(init.cache, 'no-store');
        assert.equal(init.referrerPolicy, 'no-referrer');
        assert.equal(init.keepalive, undefined);assert.deepEqual(Object.keys(init.headers), ['Content-Type']);
        assert.equal(init.headers['Content-Type'], 'application/json');
        const body = JSON.parse(init.body);
        assert.deepEqual(Object.keys(body).sort(), ['session_id', 'site']);
        assert.equal(body.site, 'scale-website');assert(uuid.test(body.session_id));assert(Buffer.byteLength(init.body) <= 256);
        requests.push({body, signal: init.signal, origin});
        if (failure === 'network') throw new Error('Offline');
        if (failure === 'pending') return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true}));
        return {ok: status === 202, status};
      }
    };
    runInNewContext(script, context, {filename: 'assets/tracking/live-visitors.js'});
    const surface = {document, intervals, timeouts,
      visibility: async value => {document.visibilityState = value ? 'visible' : 'hidden';docListeners.get('visibilitychange')?.();await flush();},
      hide: async () => {winListeners.get('pagehide')?.();await flush();},
      show: async () => {winListeners.get('pageshow')?.();await flush();}
    };
    tabs.push(surface);return surface;
  }
  return {tab, requests, jars, tabs,
    advance: async (ms = 30000, run = true) => {now += ms;if (run) tabs.forEach(t => t.intervals.forEach(fn => fn()));await flush();},
    status: value => {status = value;}, failure: value => {failure = value;},
    seed: value => jars.set('https://scaleparaguay.com', {value, expires: now + 90000}),
    now: () => now
  };
}

test('entrypoint loads the tracker once; every other HTML byte stays unchanged', () => {
  const tag = '<script src="/assets/tracking/live-visitors.js" defer></script>\n';
  assert.equal(html.split(tag).length, 2);
  assert(html.indexOf(tag) < html.indexOf('</body>'));
  // Review invariant against the clean agency baseline, without network access.
  const original = execFileSync('git', ['show', 'HEAD:index.html'], {cwd: root, encoding: 'utf8'});
  assert.equal(html.replace(tag, ''), original.replace(tag, ''));
  for (const page of ['admin.html', '404.html']) assert(!readFileSync(new URL(page, root), 'utf8').includes('live-visitors.js'));
});

test('several visible tabs generate one session and at most one heartbeat per 30s', async () => {
  const b = browser(), first = b.tab(), second = b.tab();await flush();
  assert.equal(b.requests.length, 1);const id = b.requests[0].body.session_id;
  for (let i = 0; i < 4; i++) {await second.visibility(false);await second.visibility(true);}
  assert.equal(b.requests.length, 1);
  await b.advance();assert.equal(b.requests.length, 2);assert.equal(b.requests[1].body.session_id, id);
  await first.visibility(false);await b.advance();assert.equal(b.requests.length, 3);assert.equal(b.requests[2].body.session_id, id);
  await second.visibility(false);await b.advance();assert.equal(b.requests.length, 3);
});

test('idle cookie expires after 90s; continuous sessions rotate after 15min', async () => {
  const b = browser(), page = b.tab();await flush();const first = b.requests[0].body.session_id;
  await page.visibility(false);await b.advance(90000);assert.equal(page.document.cookie, '');
  await page.visibility(true);assert.notEqual(b.requests.at(-1).body.session_id, first);
  const next = b.requests.at(-1).body.session_id;
  for (let i = 0; i < 29; i++) await b.advance();
  assert.equal(b.requests.at(-1).body.session_id, next);
  await b.advance();assert.notEqual(b.requests.at(-1).body.session_id, next);
});

test('only the two exact agency origins/root paths run; app, admin, demo, preview and frames do not', async () => {
  const b = browser();
  for (const origin of ['https://app.scaleparaguay.com', 'https://admin.scaleparaguay.com', 'https://sistema.scaleparaguay.com', 'http://scaleparaguay.com', 'https://scaleparaguay.com.evil.example', 'https://scaleparaguay.com:8443', 'http://localhost', 'null']) b.tab({origin});
  for (const path of ['/demo', '/pipeline', '/admin', '/admin.html', '/404.html', '/test']) b.tab({path});
  b.tab({frame: true});b.tab({visible: false});await flush();assert.equal(b.requests.length, 0);
  b.tab();b.tab({origin: 'https://www.scaleparaguay.com', path: '/index.html'});await flush();assert.equal(b.requests.length, 2);
  assert.notEqual(b.requests[0].body.session_id, b.requests[1].body.session_id, 'different origins are not correlated');
});

test('blocked cookies/locks/random generator do not fall back to per-tab identifiers', async () => {
  for (const options of [{blockedCookies: true}, {throwingCookies: true}, {locks: false}, {crypto: false}]) {
    const b = browser(options);b.tab();b.tab();await flush();await b.advance();assert.equal(b.requests.length, 0);
  }
});

test('malformed, future-dated or invalid UUID cookies are replaced with a valid ephemeral session', async () => {
  for (const value of ['%invalid', encodeURIComponent('{'), encodeURIComponent(JSON.stringify({id: '-'.repeat(36), born: 10000000, sent: 10000000})), encodeURIComponent(JSON.stringify({id: randomUUID(), born: 11000000, sent: 11000000}))]) {
    const b = browser();b.seed('__Host-scale_live_v1=' + value);b.tab();await flush();assert.equal(b.requests.length, 1);assert(uuid.test(b.requests[0].body.session_id));
  }
});

test('BFCache/page lifecycle stops timers and resumes without duplicating them', async () => {
  const b = browser(), page = b.tab();await flush();assert.equal(page.intervals.size, 1);
  await page.show();assert.equal(page.intervals.size, 1);assert.equal(b.requests.length, 1);
  await page.hide();assert.equal(page.intervals.size, 0);await b.advance(90000);assert.equal(b.requests.length, 1);
  await page.show();assert.equal(page.intervals.size, 1);assert.equal(b.requests.length, 2);
});

test('429 waits 60s; server/network errors wait 120s without reading private data', async () => {
  for (const scenario of [429, 503, 'network']) {
    const b = browser();if (typeof scenario === 'number') b.status(scenario);else b.failure(scenario);
    b.tab();await flush();assert.equal(b.requests.length, 1);await b.advance();assert.equal(b.requests.length, 1);
    b.status(202);b.failure('');
    if (scenario !== 429) {await b.advance();await b.advance();assert.equal(b.requests.length, 1);}
    await b.advance();assert.equal(b.requests.length, 2);
  }
});

test('pending requests never overlap and abort on timeout or hidden/pagehide', async () => {
  for (const action of ['timeout', 'hidden', 'pagehide']) {
    const b = browser();b.failure('pending');const page = b.tab();await flush();const request = b.requests[0];
    await b.advance();assert.equal(b.requests.length, 1);
    if (action === 'timeout') {page.timeouts.forEach(fn => fn());await flush();}
    else if (action === 'hidden') await page.visibility(false);
    else await page.hide();
    assert.equal(request.signal.aborted, true);assert.equal(page.timeouts.size, 0);
  }
});
