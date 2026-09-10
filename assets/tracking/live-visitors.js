// Anonymous presence for the agency website; independent of aggregate events.
// Counts estimate sessions, not named people. No IP, fingerprint, account ID,
// referrer, page history, advertising cookie or persistent browser storage.
(function () {
  const site = 'scale-website';
  const allowedOrigins = ['https://scaleparaguay.com', 'https://www.scaleparaguay.com'];
  const endpoint = 'https://admin.scaleparaguay.com/api/public/live-visitors/heartbeat';
  if (!allowedOrigins.includes(location.origin) || !['/', '/index.html'].includes(location.pathname)
      || window.top !== window || !navigator.locks || !crypto.randomUUID) return;

  // Host-only cookie expires after 90 s without a heartbeat, even after closing
  // the browser. Rotate after at most 15 min of continuous presence.
  // Web Locks coordinate tabs. If cookies or locks are blocked, omit the count.
  const cookieName = '__Host-scale_live_v1', lockName = 'scale-live-visitors-v1';
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  let stopped = false, busy = false, timer, controller, nextAttempt = 0;

  function read() {
    try {
      const value = document.cookie.split('; ').find(v => v.startsWith(cookieName + '='));
      return value ? JSON.parse(decodeURIComponent(value.slice(cookieName.length + 1))) : null;
    } catch { return null; }
  }

  async function pulse() {
    if (stopped || busy || document.visibilityState !== 'visible' || Date.now() < nextAttempt) return;
    busy = true;
    let timeout;
    try {
      const sid = await navigator.locks.request(lockName, {ifAvailable: true}, lock => {
        if (!lock || stopped || document.visibilityState !== 'visible') return null;
        const now = Date.now();
        let state = read();
        if (!state || typeof state.id !== 'string' || !uuid.test(state.id)
            || !Number.isFinite(state.born) || !Number.isFinite(state.sent)
            || now - state.sent >= 90000 || now - state.born >= 900000
            || state.born > now || state.sent > now) {
          state = {id: crypto.randomUUID(), born: now, sent: 0};
        }
        if (now - state.sent < 30000) return null;
        state.sent = now;
        document.cookie = cookieName + '=' + encodeURIComponent(JSON.stringify(state))
          + '; Max-Age=90; Path=/; Secure; SameSite=Strict';
        if (read()?.id !== state.id) return null;
        return state.id;
      });
      if (!sid || stopped || document.visibilityState !== 'visible') return;
      nextAttempt = Date.now() + 30000;
      controller = new AbortController();
      timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
        headers: {'Content-Type': 'application/json'}, body: JSON.stringify({site, session_id: sid})
      });
      if (!response.ok) nextAttempt = Date.now() + (response.status === 429 ? 60000 : 120000);
    } catch {
      nextAttempt = Date.now() + 120000;
    } finally {
      clearTimeout(timeout);
      busy = false;
    }
  }

  function start() {
    stopped = false;
    clearInterval(timer);
    timer = setInterval(() => void pulse(), 30000);
    void pulse();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void pulse();
    else controller?.abort();
  });
  window.addEventListener('pagehide', () => {
    stopped = true;
    clearInterval(timer);
    controller?.abort();
  });
  window.addEventListener('pageshow', start);
  start();
})();
