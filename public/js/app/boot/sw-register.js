import { EVT } from '../../events.js';
import { lsGet } from '../../safe-storage.js';
import { fetchJson } from '../../utils.js';
import { SHELL_PROTOCOL } from '../../shell-protocol.js';
import {
  AUTO_APPLY_TICK_MS, isBusy, shouldAutoApply, isUpdateRequired, shouldForceUpdate,
} from './update-policy.js';
import { createBusyLock, activateIfNobodyBusy } from './busy-lock.js';

// Service Worker: cached SPA-Shell für Offline/Zug-Modus. Nur über HTTPS bzw.
// localhost registrierbar. Fehler schlucken – SW ist Progressive Enhancement.
// Dev/Localhost: SW deaktiviert (Cache-Artefakte beim Entwickeln eklig).
// Override pro Browser via `localStorage.setItem('sw', '1')` (an) bzw. `'0'` (aus).
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const swPref = lsGet('sw');
  const isLocal = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  const swEnabled = swPref === '1'
    || (swPref !== '0' && location.protocol === 'https:' && !isLocal);

  if (!swEnabled) {
    // Ohne SW holt jeder Reload die aktuelle Shell; ein Pflicht-Update braucht
    // nur das Banner (applyUpdate fällt auf location.reload() zurück).
    window.__requireUpdate = () => {};
    navigator.serviceWorker.getRegistrations()
      .then(regs => regs.forEach(r => r.unregister()))
      .catch(() => {});
    if (window.caches) {
      caches.keys()
        .then(keys => Promise.all(keys.map(k => caches.delete(k))))
        .catch(() => {});
    }
    return;
  }

  window.addEventListener('load', async () => {
    try {
      // updateViaCache:'none' → Update-Checks revalidieren sw.js UND seine
      // importScripts (/sw-manifest.js) immer frisch vom Netz. Ohne das nutzt
      // der Default ('imports') den HTTP-Cache für importierte Skripte, und ein
      // neuer Build (nur Manifest-Hash geändert) würde u.U. nicht erkannt.
      const reg = await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      // Periodisch nach Updates fragen — ohne aktiven update()-Call wartet
      // der Browser u.U. Stunden bis Tage, bis er einen neuen SW
      // einspielt; v.a. auf Mobile (Tab im Hintergrund / SW gekillt) sieht
      // der User Frontend-Updates dann nie. 60s ist günstig: minimale
      // Bandbreite (nur sw.js wird revalidiert), schnelle Sichtbarkeit.
      // Im versteckten Tab pausieren (Funk/Akku auf Mobile) und beim
      // Wiedersichtbarwerden einmal sofort nachholen.
      setInterval(() => { if (!document.hidden) reg.update().catch(() => {}); }, 60_000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) reg.update().catch(() => {});
      });
      // Controllerchange feuert erst, nachdem jemand den wartenden SW per
      // 'skip-waiting' aktiviert hat — Banner-Klick (applyUpdate) oder die
      // Update-Politik weiter unten; sw.js macht bewusst kein skipWaiting/
      // clients.claim beim Deploy. Bis dahin bedient der ALTE SW die laufende
      // Seite kohärent (alte Partials + alte Module). Auto-Reload hier nur,
      // wenn niemand editiert — sonst Banner stehen lassen, damit der User
      // erst speichern kann.
      // hadController-Snapshot: beim First-Install (Tab ohne Controller
      // geladen) feuert clients.claim() ein controllerchange — ohne Snapshot
      // würde die Seite direkt nach dem ersten Laden nochmal reloaden.
      const hadController = !!navigator.serviceWorker.controller;
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController) return;
        if (reloaded) return;
        reloaded = true;
        const app = window.__app;
        // Niemals auto-reloaden, wenn der User aktiv editiert oder im
        // Fokusmodus liest/schreibt (update-policy.js#isBusy).
        if (isBusy(app)) {
          app.$store.shell.updateAvailable = true;
          return;
        }
        // Offline nicht reloaden: der frisch aktivierte SW hat die alte
        // Generation gelöscht, und ob seine eigene noch vollständig im Cache
        // liegt (iOS evictiert Einzeleinträge), weiss hier niemand. Fehlt
        // offline auch nur ein Modul, bootet Alpine nicht und der Body bleibt
        // hinter dem data-app-loading-Gate unsichtbar (schwarz). Die laufende
        // Seite dagegen funktioniert. Stattdessen Banner; Reload kommt beim
        // nächsten Online-Wechsel.
        if (!navigator.onLine) {
          if (app) app.$store.shell.updateAvailable = true;
          window.addEventListener('online', () => location.reload(), { once: true });
          return;
        }
        location.reload();
      });

      // Tab-übergreifende Editier-Sperre (busy-lock.js): dieser Tab hält den
      // geteilten Lock, solange er editiert. Abgeglichen im Sekundentakt und
      // bei jeder Eingabe (markInput unten) — sonst könnte ein anderer Tab in
      // der Lücke zwischen erstem Tastendruck und nächstem Tick aktivieren.
      const busyLock = createBusyLock({ isBusy: () => isBusy(window.__app) });
      setInterval(busyLock.sync, 1000);

      // Den wartenden SW aktivieren — aber nur, wenn in KEINEM Tab editiert
      // wird: skip-waiting wechselt die Generation für alle Tabs der Origin.
      // Den Reload macht der controllerchange-Listener oben (in jedem Tab nach
      // dessen eigener isBusy-Prüfung). Liefert ein Promise<boolean>.
      const activateWaiting = () => {
        const w = reg.waiting || window.__pendingWorker;
        if (!w) return Promise.resolve(false);
        busyLock.sync();
        return activateIfNobodyBusy(() => {
          try { w.postMessage({ type: 'skip-waiting' }); } catch { return false; }
          return true;
        });
      };

      // Reload in eine kohärente Generation — geteilt von 'shell-incoherent'
      // (SW evictierte einen Einzeleintrag) und dem Boot-Build-Guard
      // (Server-Build ≠ geladene Shell). Beim Editieren nur Banner (User soll
      // erst speichern), offline aufschieben bis online. Loop-Schutz: max. ein
      // automatischer Reload pro 30 s (sessionStorage), sonst Banner — sonst
      // könnte eine dauerhaft evictierte Datei eine Reload-Schleife treiben.
      const requestCoherentReload = async () => {
        const app = window.__app;
        if (isBusy(app)) {
          if (app) app.$store.shell.updateAvailable = true;
          return;
        }
        if (!navigator.onLine) {
          if (app) app.$store.shell.updateAvailable = true;
          window.addEventListener('online', () => location.reload(), { once: true });
          return;
        }
        // Wartet schon ein neuer SW, hilft ein blosser Reload nicht: der alte SW
        // kontrolliert die Seite über den Reload hinweg und liefert wieder die
        // alte Shell. Erst aktivieren — den Reload macht controllerchange.
        // Editiert ein ANDERER Tab, bleibt die Aktivierung aus und der Reload
        // unten ist der Rückfall (Loop-Schutz greift).
        if (await activateWaiting()) return;
        let last = 0;
        try { last = Number(sessionStorage.getItem('sw-coherent-reload') || 0); } catch {}
        const now = Date.now();
        if (now - last < 30_000) {
          if (app) app.$store.shell.updateAvailable = true;
          return;
        }
        try { sessionStorage.setItem('sw-coherent-reload', String(now)); } catch {}
        location.reload();
      };
      window.__requestCoherentReload = requestCoherentReload;

      // Vom Update-Banner ("Neu laden") aufgerufen. Normalfall: einen
      // wartenden SW via 'skip-waiting' aktivieren → controllerchange-Listener
      // oben macht den Reload in die neue Generation. Loop-Breaker: Gibt es
      // KEINEN wartenden SW (Build-Guard-Banner ohne neuen Worker, im install
      // gescheitertes cache.addAll, vom Mobile-Browser verworfener Worker),
      // bringt ein reiner location.reload() nichts — der alte SW bedient die
      // alte Shell + alte sw-manifest.js weiter, der Build-Guard feuert erneut,
      // der Banner kommt wieder (Endlos-Loop). Dann erst einen Update-Check
      // erzwingen; bleibt es nach dem zweiten Versuch beim Mismatch, hart
      // heilen: Shell-Caches wegwerfen + SW abmelden + frisch laden. Tragend ist
      // der Cache-Wurf, nicht die Abmeldung — Chromium holt die Registrierung beim
      // nächsten register() derselben Script-URL ohne Install zurück. Der SW
      // erkennt die fehlende Generation selbst (sw.js#GENERATION_COMPLETE_PATH),
      // bedient die Seite dann vom Netz und füllt nach.
      let applying = false;
      const applyUpdate = async () => {
        if (applying) return;
        applying = true;
        const w = window.__pendingWorker || reg.waiting;
        if (w) {
          try { w.postMessage({ type: 'skip-waiting' }); } catch {}
          setTimeout(() => location.reload(), 2000);
          return;
        }
        let attempts = 0;
        try { attempts = Number(sessionStorage.getItem('sw-update-attempts') || 0); } catch {}
        attempts += 1;
        try { sessionStorage.setItem('sw-update-attempts', String(attempts)); } catch {}
        if (attempts < 2) {
          try { await reg.update(); } catch {}
          const fresh = reg.waiting || window.__pendingWorker;
          if (fresh) { try { fresh.postMessage({ type: 'skip-waiting' }); } catch {} }
          setTimeout(() => location.reload(), 2000);
          return;
        }
        try {
          if (window.caches) {
            const keys = await caches.keys();
            await Promise.all(
              keys.filter(k => k.startsWith('schreibwerkstatt-shell-')).map(k => caches.delete(k))
            );
          }
        } catch {}
        try { await reg.unregister(); } catch {}
        try { sessionStorage.removeItem('sw-update-attempts'); } catch {}
        location.reload();
      };
      window.__applyUpdate = applyUpdate;

      // ── Update-Politik (update-policy.js) ─────────────────────────────────
      // Ein wartender SW wird eingespielt, sobald dabei nichts verloren geht:
      // beim Boot sofort, später im Hintergrund-Tab oder nach einer Weile ohne
      // Eingabe. Wer editiert, bekommt nur das Banner.
      let lastInput = Date.now();
      const markInput = () => { lastInput = Date.now(); busyLock.sync(); };
      for (const ev of ['keydown', 'pointerdown', 'wheel', 'touchstart']) {
        window.addEventListener(ev, markInput, { capture: true, passive: true });
      }

      // Pflicht-Update (Server-Protokoll > SHELL_PROTOCOL): wartet nur noch auf
      // ungespeicherte Änderungen; applyUpdate heilt auch ohne wartenden SW.
      const requireUpdate = () => {
        const app = window.__app;
        if (app) app.$store.shell.updateRequired = true;
        if (shouldForceUpdate({ dirty: !!app?.editDirty, online: navigator.onLine })) applyUpdate();
      };
      window.__requireUpdate = requireUpdate;

      const tryAutoApply = () => {
        const app = window.__app;
        if (app?.$store?.shell?.updateRequired) { requireUpdate(); return; }
        if (!reg.waiting) return;
        if (shouldAutoApply({
          hidden: document.hidden,
          idleMs: Date.now() - lastInput,
          busy: isBusy(app),
          online: navigator.onLine,
        })) activateWaiting();
      };
      setInterval(tryAutoApply, AUTO_APPLY_TICK_MS);
      document.addEventListener('visibilitychange', () => { if (document.hidden) tryAutoApply(); });

      // Neuer SW installiert: Banner zeigen, frisch nach dem Shell-Protokoll
      // fragen (ein Pflicht-Update kommt meist zusammen mit einem Deploy) und
      // gleich prüfen, ob er still eingespielt werden kann.
      const notify = (worker) => {
        if (!worker || !navigator.serviceWorker.controller) return;
        window.__pendingWorker = worker;
        window.dispatchEvent(new CustomEvent(EVT.APP_UPDATE_AVAILABLE));
        fetchJson('/config?__fresh=1').then((cfg) => {
          if (isUpdateRequired(cfg?.shellProtocol, SHELL_PROTOCOL)) requireUpdate();
        }).catch(() => {});
        tryAutoApply();
      };
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        nw?.addEventListener('statechange', () => {
          if (nw.state === 'installed') notify(nw);
        });
      });

      // Boot: liegt beim Laden schon ein wartender SW vor, ist noch nichts
      // getippt — sofort einspielen statt erst das Banner zu zeigen. Nur wenn
      // die Seite bereits kontrolliert ist (sonst ist es der Erst-Install).
      // Editiert gerade ein anderer Tab (typisch: zweiter Tab zum Nachschlagen
      // geöffnet), sperrt busy-lock.js die Aktivierung — dann Banner.
      if (reg.waiting && navigator.serviceWorker.controller) {
        const waiting = reg.waiting;
        const tryBoot = !isBusy(window.__app) && navigator.onLine
          ? activateWaiting() : Promise.resolve(false);
        tryBoot.then((done) => { if (!done) notify(waiting); });
      }
      if (window.__updateRequiredPending) {
        window.__updateRequiredPending = false;
        requireUpdate();
      }

      // Der SW meldet eine Cache-Lücke (Einzel-Eviction → er musste eine
      // möglicherweise generationsfremde Datei durchreichen). Frischen
      // Update-Check anstossen (ein wartender SW läuft über controllerchange)
      // und in eine kohärente Generation reloaden.
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'shell-incoherent') {
          reg.update().catch(() => {});
          requestCoherentReload();
        }
      });
    } catch {}
  });
}
