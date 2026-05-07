/*! Tero Stage 2 traffic-split shim — https://tero.run
 *  This script is added once during onboarding and stays in your repo.
 *  When Tero is running an active Stage 2 A/B test on this blueprint, it
 *  splits traffic 50/50 between prod and the variant preview URL with a
 *  sticky cookie, then reports conversion events back. When no test is
 *  active (the common case), it does ~one cached fetch per 5 minutes and
 *  is otherwise a no-op.
 *
 *  Drop-in: <script src="/tero-shim.js" data-tero-token="…" defer></script>
 *  Token: blueprints.shim_token in your Tero workspace.
 *
 *  ─ Notes ────────────────────────────────────────────────────────────────
 *  • Vanilla JS, no deps, no globals beyond `window.tero`.
 *  • Cookie SameSite=Lax 7d; Safari ITP compatible (no third-party iframes).
 *  • <5KB minified target.
 *  • Negative result is cached in sessionStorage 5 min — first paint is
 *    blocked at most once per session per 5 min.
 *  • Failures are silent — the customer's app must always work even if
 *    api.tero.run is down.
 */
(function () {
  "use strict";
  if (window.__teroShimLoaded) return;
  window.__teroShimLoaded = true;

  // Resolve config off the <script> tag itself. Customers don't need a
  // separate config block — the data-* attrs are the only knobs.
  var script = document.currentScript ||
    (function () {
      var els = document.getElementsByTagName("script");
      for (var i = els.length - 1; i >= 0; i--) {
        if (els[i].src && els[i].src.indexOf("tero-shim") !== -1) return els[i];
      }
      return null;
    })();
  var TOKEN = script && script.getAttribute("data-tero-token");
  // Override host (rare — only for staging/local). Defaults to api.tero.run
  // which routes to the prod Supabase edge fns.
  var API = (script && script.getAttribute("data-tero-api")) || "https://api.tero.run";
  if (!TOKEN) return; // nothing to do

  // ── Cookies / storage helpers ─────────────────────────────────────────
  function getCookie(name) {
    var pairs = document.cookie ? document.cookie.split("; ") : [];
    for (var i = 0; i < pairs.length; i++) {
      var idx = pairs[i].indexOf("=");
      if (idx > -1 && pairs[i].slice(0, idx) === name) {
        try { return decodeURIComponent(pairs[i].slice(idx + 1)); } catch (e) { return null; }
      }
    }
    return null;
  }
  function setCookie(name, value, days) {
    var d = new Date();
    d.setTime(d.getTime() + (days || 7) * 86400000);
    document.cookie = name + "=" + encodeURIComponent(value) +
      "; expires=" + d.toUTCString() +
      "; path=/; SameSite=Lax" +
      (location.protocol === "https:" ? "; Secure" : "");
  }
  function rand() {
    // Crypto-grade randomness when available — falls back to Math.random.
    // Only used for tie-breaking the 50/50 split, so weakness is fine.
    if (window.crypto && crypto.getRandomValues) {
      var a = new Uint32Array(1); crypto.getRandomValues(a);
      return a[0] / 4294967296;
    }
    return Math.random();
  }
  function sessionId() {
    var key = "tero_sid";
    var sid;
    try { sid = sessionStorage.getItem(key); } catch (e) { sid = null; }
    if (!sid) {
      sid = (rand().toString(36).slice(2) + Date.now().toString(36)).slice(0, 16);
      try { sessionStorage.setItem(key, sid); } catch (e) { /* private mode */ }
    }
    return sid;
  }

  // ── Active-route fetch (cached) ───────────────────────────────────────
  // Cache the negative response 5 min so 99% of pageviews on idle apps
  // don't even hit the network. The cached "no test" response is keyed
  // off the token so a token rotation immediately invalidates it.
  var ACTIVE_CACHE_KEY = "tero_active_v1_" + TOKEN.slice(0, 8);
  var ACTIVE_TTL_MS = 5 * 60 * 1000;
  function readActiveCache() {
    try {
      var raw = sessionStorage.getItem(ACTIVE_CACHE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.t !== "number") return null;
      if (Date.now() - parsed.t > ACTIVE_TTL_MS) return null;
      return parsed.v;
    } catch (e) { return null; }
  }
  function writeActiveCache(v) {
    try { sessionStorage.setItem(ACTIVE_CACHE_KEY, JSON.stringify({ t: Date.now(), v: v })); }
    catch (e) { /* private mode / quota */ }
  }
  function fetchActiveRoute(cb) {
    var cached = readActiveCache();
    if (cached !== null) { cb(cached); return; }
    // GET keeps it CDN-cacheable, no preflight, lower TTFB. Token in header.
    try {
      fetch(API + "/functions/v1/stage2-active-route", {
        method: "GET",
        headers: { "X-Tero-Shim-Token": TOKEN },
        // credentials omitted on purpose — this is a third-party origin
        // and the customer's session cookies must NOT travel here.
        credentials: "omit",
        cache: "no-store",
      }).then(function (r) { return r.ok ? r.json() : { route: null }; })
        .then(function (data) {
          var route = data && data.route ? data.route : null;
          var blueprintId = data && data.blueprint_id ? data.blueprint_id : null;
          var v = { route: route, blueprint_id: blueprintId };
          writeActiveCache(v);
          cb(v);
        })
        .catch(function () { cb({ route: null, blueprint_id: null }); });
    } catch (e) { cb({ route: null, blueprint_id: null }); }
  }

  // ── Event reporting ───────────────────────────────────────────────────
  // Use sendBeacon when available — survives page unload (visibilitychange
  // hidden, link clicks). Falls back to fetch with keepalive.
  function postEvent(payload) {
    try {
      // Beacon doesn't let us set custom headers, so embed token in body.
      // Edge fn tolerates either header or body-token (see stage2-event).
      payload._tero_token = TOKEN;
      var body = JSON.stringify(payload);
      var url = API + "/functions/v1/stage2-event";
      if (navigator.sendBeacon) {
        if (navigator.sendBeacon(url, new Blob([body], { type: "application/json" }))) return;
      }
      fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Tero-Shim-Token": TOKEN },
        body: body, keepalive: true, credentials: "omit",
      }).catch(function () {});
    } catch (e) {}
  }

  // ── Conversion detection ─────────────────────────────────────────────
  function urlMatch(p) {
    if (!p) return false;
    try {
      // /regex/ literal → RegExp. Otherwise substring match against href.
      if (p.charAt(0) === "/" && p.charAt(p.length - 1) === "/")
        return new RegExp(p.slice(1, -1)).test(location.href);
      return location.href.indexOf(p) !== -1 || location.pathname === p;
    } catch (e) { return false; }
  }
  function selectorMatched(s) {
    try { return !!s && !!document.querySelector(s); } catch (e) { return false; }
  }

  // ── Main ──────────────────────────────────────────────────────────────
  var COOKIE_PREFIX = "tero_assignment_";
  // Lazy lookup — we don't know blueprint_id until the first server
  // response. Until then, look for ANY existing tero_assignment_* cookie
  // so we don't issue a duplicate on subsequent navigations.
  function findExistingAssignment() {
    var pairs = document.cookie ? document.cookie.split("; ") : [];
    for (var i = 0; i < pairs.length; i++) {
      var p = pairs[i];
      if (p.indexOf(COOKIE_PREFIX) === 0) {
        var idx = p.indexOf("=");
        return {
          blueprintId: p.slice(COOKIE_PREFIX.length, idx),
          value: idx > -1 ? decodeURIComponent(p.slice(idx + 1)) : null,
        };
      }
    }
    return null;
  }

  // The api object exposed to the customer's code for manual conversion
  // tracking: window.tero.markConversion('signup_completed').
  // window.tero.markConversion('signup_completed') — manual hook for SPA apps
  window.tero = window.tero || {
    markConversion: function (eventName) {
      var ex = findExistingAssignment();
      if (!ex || !ex.blueprintId) return;
      postEvent({
        type: "conversion", blueprint_id: ex.blueprintId,
        user_id_hash: ex.value || sessionId(), session_id: sessionId(),
        url: location.href, conversion_event: eventName || "manual", converted: true,
      });
    },
  };
  // Also fire a custom event consumers can listen for to integrate with
  // their own analytics: window.addEventListener('tero:assigned', ...)
  function emit(name, detail) {
    try {
      window.dispatchEvent(new CustomEvent("tero:" + name, { detail: detail }));
    } catch (e) { /* old IE — never gonna happen, but cheap */ }
  }

  fetchActiveRoute(function (resp) {
    var route = resp && resp.route;
    var blueprintId = resp && resp.blueprint_id;
    if (!route || !blueprintId) return; // no test active — we're done

    var cookieName = COOKIE_PREFIX + blueprintId;
    var existing = getCookie(cookieName);
    var assignment;
    var split = typeof route.traffic_split === "number" ? route.traffic_split : 0.5;
    var variantUrl = route.variant_url;
    var prodUrl = route.prod_url || (location.origin + "/");
    var conversionUrl = route.conversion_url;
    var conversionSelector = route.conversion_selector;
    var runId = route.run_id;

    if (existing === "variant" || existing === "prod") {
      assignment = existing;
    } else {
      assignment = rand() < split ? "variant" : "prod";
      setCookie(cookieName, assignment, 7);
      // Fire assignment event server-side. user_id_hash is the
      // sessionId for now — we don't have stable user identity in the
      // shim, and the customer can lift this with markConversion()'s
      // optional auth hash later.
      postEvent({
        type: "assignment",
        blueprint_id: blueprintId,
        run_id: runId,
        user_id_hash: sessionId(),
        cohort: assignment,
        session_id: sessionId(),
        url: location.href,
        timestamp: new Date().toISOString(),
      });
    }
    emit("assigned", { assignment: assignment, blueprint_id: blueprintId });

    // Variant routing — only redirect if we're actually on the prod URL
    // (defensive: if a redirect loops, the next pageview will see the
    // variant URL is the current origin and won't redirect again).
    if (assignment === "variant" && variantUrl) {
      var alreadyOnVariant = (function () {
        try {
          var u = new URL(variantUrl);
          return u.host === location.host;
        } catch (e) { return false; }
      })();
      if (!alreadyOnVariant) {
        // Preserve path + query + hash so deep links don't break.
        try {
          var v = new URL(variantUrl);
          v.pathname = location.pathname;
          v.search = location.search;
          v.hash = location.hash;
          location.replace(v.toString());
          return; // page is unloading
        } catch (e) { /* malformed variant_url — fall through, no redirect */ }
      }
    }

    // ── Conversion watch ───────────────────────────────────────────────
    var converted = false;
    function fireConversion(reason) {
      if (converted) return;
      converted = true;
      postEvent({
        type: "conversion", blueprint_id: blueprintId, run_id: runId,
        user_id_hash: sessionId(), session_id: sessionId(), cohort: assignment,
        url: location.href, conversion_event: reason, converted: true,
      });
      emit("conversion", { assignment: assignment, reason: reason });
    }

    // a) Custom event from app code: window.dispatchEvent(new Event('tero:conversion'))
    window.addEventListener("tero:conversion", function () { fireConversion("custom_event"); });

    // b) URL pattern match — fire if current page already matches, plus
    //    listen for SPA navigations.
    if (conversionUrl && urlMatch(conversionUrl)) {
      // Defer to give the page a tick to set its real URL on SPA mounts.
      setTimeout(function () { fireConversion("url_match"); }, 0);
    }
    if (conversionUrl && window.history && window.history.pushState) {
      var origPush = history.pushState;
      var origReplace = history.replaceState;
      history.pushState = function () {
        origPush.apply(this, arguments);
        if (urlMatch(conversionUrl)) fireConversion("url_match_spa");
      };
      history.replaceState = function () {
        origReplace.apply(this, arguments);
        if (urlMatch(conversionUrl)) fireConversion("url_match_spa");
      };
      window.addEventListener("popstate", function () {
        if (urlMatch(conversionUrl)) fireConversion("url_match_spa");
      });
    }

    // c) Selector match — pages with a "Thanks for signing up" element etc.
    //    Polled every 1s for up to 30s post-load. Cheaper than a full-tree
    //    MutationObserver for the SPA rerender case, and we're only watching
    //    for the appearance of one selector.
    if (conversionSelector) {
      var tries = 0;
      var pollSel = setInterval(function () {
        if (converted || ++tries > 30) { clearInterval(pollSel); return; }
        if (selectorMatched(conversionSelector)) {
          clearInterval(pollSel);
          fireConversion("selector_match");
        }
      }, 1000);
    }

    // d) On-hide non-conversion ping — fires once when the user navigates
    //    away without converting. Server treats absent ping as "still
    //    looking", so this is a tiny perf win for analysis windows.
    var hiddenSent = false;
    function onHide() {
      if (hiddenSent || converted || document.visibilityState !== "hidden") return;
      hiddenSent = true;
      postEvent({
        type: "session_end", blueprint_id: blueprintId, run_id: runId,
        user_id_hash: sessionId(), session_id: sessionId(), cohort: assignment,
        converted: false,
      });
    }
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
  });
})();
