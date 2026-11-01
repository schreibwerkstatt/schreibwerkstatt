// Client-JS-Fehler-Reporter: faengt unbehandelte Fehler + Promise-Rejections
// global ab und meldet sie fire-and-forget an /telemetry/js-error (Server
// persistiert in js_errors, Admin sieht sie unter /admin/js-errors).
//
// Klassisches Script (kein module/defer), frueh in <head> geladen — damit auch
// Boot-Fehler des ESM-Graphen erfasst werden. Externe Datei statt Inline, damit
// CSP ohne 'unsafe-inline' auskommt.
//
// Best-effort: scheitert der Report selbst, wird er geschluckt — Telemetrie darf
// nie eine Fehlerschleife ausloesen. Dedup + Throttle gegen Log-Flut.
//
// Exportiert `window.__reportClientError(payload)`, damit failsafe-reveal.js den
// Boot-Ausfall selbst melden kann, ohne fetch/Dedup/Throttle zu duplizieren.
// Beide sind klassische Scripts; client-error.js laedt zuerst (index.html), der
// Zugriff erfolgt ohnehin erst zur Ereigniszeit.
(function () {
  var MAX_REPORTS = 25;       // pro Page-Load, danach still
  var WINDOW_MS = 60 * 1000;  // gleiche Signatur max 1x pro Minute
  var sent = 0;
  var seen = Object.create(null);

  function report(payload) {
    if (sent >= MAX_REPORTS) return;
    var sig = (payload.message || '') + '|' + (payload.source || '') + '|' + (payload.line || '');
    var now = Date.now();
    if (seen[sig] && now - seen[sig] < WINDOW_MS) return;
    seen[sig] = now;
    sent++;
    try {
      fetch('/telemetry/js-error', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
        keepalive: true,
      }).catch(function () {});
    } catch (e) { /* ignore */ }
  }

  window.__reportClientError = report;

  // Netz-Diagnose fuer einen Ladefehler: der Server-/Proxy-Log zeigt nur, was
  // ankam — ob der Browser den Request ueberhaupt abgeschickt hat, sieht man
  // nur hier. Fehlt die Resource-Timing-Zeile, hat der Browser ihn nie
  // abgeschlossen (verworfen, bevor er ins Netz ging, oder abgebrochen);
  // `status=0` mit Bytes = Antwort kam, Verarbeitung scheiterte. Dazu der
  // Seitenkontext, der Abbrueche erklaert (SW, Sichtbarkeit, Navigationsart).
  function entryLine(r) {
    return 'status=' + (r.responseStatus == null ? '?' : r.responseStatus)
      + ' proto=' + (r.nextHopProtocol || '-')
      + ' transfer=' + r.transferSize
      + ' body=' + r.encodedBodySize
      + ' start=' + Math.round(r.startTime) + 'ms'
      + ' dur=' + Math.round(r.duration) + 'ms'
      + (r.deliveryType ? ' delivery=' + r.deliveryType : '');
  }

  function resourceDiag(url) {
    var lines = [];
    try {
      var entries = url ? performance.getEntriesByName(url) : [];
      lines.push(entries.length
        ? 'timing: ' + entryLine(entries[entries.length - 1])
        : 'timing: keine Zeile (Request nie abgeschlossen)');
    } catch (_) { lines.push('timing: n/a'); }
    try {
      var nav = performance.getEntriesByType('navigation')[0];
      var conn = navigator.connection;
      lines.push('page: t=' + Math.round(performance.now()) + 'ms'
        + ' nav=' + (nav ? nav.type : '?')
        + ' ready=' + document.readyState
        + ' visible=' + document.visibilityState
        + ' online=' + (navigator.onLine !== false)
        + ' sw=' + (navigator.serviceWorker
          ? (navigator.serviceWorker.controller ? 'controlled' : 'uncontrolled') : 'n/a')
        + (conn && conn.effectiveType ? ' net=' + conn.effectiveType : ''));
    } catch (_) {}
    try {
      var all = performance.getEntriesByType('resource');
      var failed = all.filter(function (r) {
        return r.responseStatus === 0 || r.responseStatus >= 400;
      });
      lines.push('resources: ' + all.length + ' geladen, ' + failed.length + ' ohne Erfolg');
      failed.slice(0, 15).forEach(function (r) { lines.push('  ' + r.name + ' ' + entryLine(r)); });
    } catch (_) {}
    return lines.join('\n');
  }
  window.__resourceDiag = resourceDiag;

  // Capture-Phase ist Pflicht fuer den Resource-Zweig unten: Ladefehler von
  // Script/Link/Img bubblen NICHT, sie sind nur im Capture am window sichtbar.
  window.addEventListener('error', function (e) {
    if (!e) return;

    // Resource-Ladefehler haben kein e.message. Script + Stylesheet werden
    // gemeldet — genau sie sind die URSACHE eines Boot-Ausfalls, waehrend die
    // Folgefehler ("X is not defined") den eigentlichen Ausloeser verdecken.
    // Bilder bleiben aussen vor, sonst fluten 404-Assets das Log.
    if (!e.message) {
      var el = e.target;
      var tag = el && el.tagName;
      if (tag !== 'SCRIPT' && tag !== 'LINK') return;
      var url = (el.src || el.href || '') + '';
      report({
        kind: 'resource',
        message: tag + ' nicht ladbar: ' + (url || '(unbekannt)'),
        stack: resourceDiag(url),
        source: url || null,
        line: null,
        col: null,
        pageUrl: location.href,
      });
      return;
    }

    report({
      kind: 'error',
      message: String(e.message),
      stack: e.error && e.error.stack ? String(e.error.stack) : null,
      source: e.filename || null,
      line: typeof e.lineno === 'number' ? e.lineno : null,
      col: typeof e.colno === 'number' ? e.colno : null,
      pageUrl: location.href,
    });
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    var reason = e ? e.reason : null;
    var message, stack = null;
    if (reason instanceof Error) {
      message = reason.message || String(reason);
      stack = reason.stack ? String(reason.stack) : null;
    } else {
      try { message = typeof reason === 'string' ? reason : JSON.stringify(reason); }
      catch (err) { message = String(reason); }
    }
    if (!message) return;
    report({
      kind: 'unhandledrejection',
      message: String(message),
      stack: stack,
      source: null,
      line: null,
      col: null,
      pageUrl: location.href,
    });
  });
})();
