// Start-Verbraucher der installierten Web-App (`window.launchQueue`): Shortcuts
// und Dateien. Das Manifest meldet `.swbook` als
// Dateityp (manifest.webmanifest#file_handlers). Öffnet das Betriebssystem eine
// solche Datei mit der App, liefert der Browser sie über `window.launchQueue`
// (nur Chromium, nur installiert). Ohne diesen Verbraucher startete die App
// und täte nichts.
//
// Die Datei geht an die Import-Karte (cards/folder-import-card.js). Weil deren
// Partial beim Start noch nicht geladen sein kann, liegt sie zusätzlich in
// `window.__pendingImportFile`, bis die Karte sie abholt.
import { EVT } from '../../events.js';

export const LAUNCH_KINDS = [{ re: /\.swbook$/i, kind: 'swbook' }];

export function kindOfFile(name) {
  return LAUNCH_KINDS.find((k) => k.re.test(String(name || '')))?.kind || null;
}

// Ziel-Hash eines Starts in ein schon offenes Fenster. Das Manifest setzt
// `launch_handler: focus-existing` (kein zweites Fenster, kein Reload über
// ungespeicherte Änderungen) — dann navigiert der Browser NICHT selbst, sondern
// reicht die Start-URL (z.B. ein Shortcut `/#meine-buecher`) hier durch.
// Nur der Hash zählt; die App routet ausschliesslich darüber.
export function launchHash(targetURL, currentHash) {
  if (!targetURL) return null;
  let hash;
  try { hash = new URL(targetURL).hash; } catch { return null; }
  return hash && hash !== currentHash ? hash : null;
}

export function installFileLaunch() {
  if (typeof window === 'undefined' || !('launchQueue' in window)) return;
  window.launchQueue.setConsumer(async (params) => {
    if (!params?.files?.length) {
      const hash = launchHash(params?.targetURL, location.hash);
      if (hash) location.hash = hash;
      return;
    }
    for (const handle of params.files) {
      const kind = kindOfFile(handle.name);
      if (!kind) continue;
      let file;
      try { file = await handle.getFile(); } catch { continue; }
      window.__pendingImportFile = { file, kind };
      const app = window.__app;
      if (app && !app.showFolderImportCard) await app.toggleFolderImportCard?.();
      window.dispatchEvent(new CustomEvent(EVT.IMPORT_FILE_LAUNCHED, { detail: { file, kind } }));
      return; // eine Datei pro Start — die Karte importiert genau eine
    }
  });
}
