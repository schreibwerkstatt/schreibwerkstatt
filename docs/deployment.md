# Deployment & Selbst-Hosting

Ausführliche Anleitung für den Betrieb und das Selbst-Hosting von Schreibwerkstatt.

## Voraussetzungen

- Node.js v24–26 (`engines: >=24 <27`; unpdf 2 verlangt Node 24, und `npm test` übergibt Globs an `node --test`). Empfohlen und auf Prod + Demo: Node 26 (`.nvmrc`, `NODE_MAJOR` in den Install-Skripten); Umstieg einer bestehenden Installation: [Node-Major wechseln](#node-major-wechseln).
- Öffentliche HTTPS-URL (Reverse-Proxy mit TLS) für Produktion.
- Login-Pfad: **Admin-Bootstrap** (Email+Passwort via ENV) und/oder **Google OAuth2** (Callback `https://<domain>/auth/callback`). Mindestens einer muss konfiguriert sein.

## Quick Start (Selbst-Hosting)

```bash
git clone https://github.com/<user>/schreibwerkstatt.git
cd schreibwerkstatt
cp .env.example .env   # SESSION_SECRET (32+ Hex) ist Pflicht
npm ci --omit=dev
node server.js         # Port 3737
```

KI-Provider, Google-OAuth, App-URL, Modell-Limits, Mailer, Cron, veraPDF/EPUBCheck sowie die optionalen self-hosted Dienste (LanguageTool, Whisper-Diktat) konfiguriert die **Admin-Konsole** (Tabelle `app_settings`, kein Restart nötig).

Produktiv: systemd-Service via [deploy/schreibwerkstatt.service](deploy/schreibwerkstatt.service), Erst-Install `bash deploy/install.sh`, CD `bash deploy/deploy.sh`.

### Deploy-Migrations

Einmalige Prod-Anpassungen (Dateisystem-Cleanup, chown-Fixes, sqlite3-Touches) gehören als idempotente Shell-Scripts unter [deploy/migrations/](deploy/migrations/) — Konvention `NNN-slug.sh` (3-stellige fortlaufende Nummer). [deploy/apply-migrations.sh](deploy/apply-migrations.sh) läuft nach jedem Deploy (nach rsync + chown, vor `npm install`), führt nur Scripts aus, deren `NNN` nicht in `$INSTALL_DIR/.deploy-migrations-applied` steht, und appendet bei Erfolg. Script erhält `$INSTALL_DIR` als `$1`. Fehler bricht Deploy ab. Migration trotzdem idempotent schreiben (Marker könnte verloren gehen).

### Reverse-Proxy

Fertige, kommentierte NGINX-Konfiguration: [deploy/nginx.conf](deploy/nginx.conf) (TLS-Terminierung, HTTP→HTTPS-Redirect, ungepufferte SSE-Streams, ZIP-Import bis 200 MB, STT-Audio, Long-Cache für Vendor/Fonts). `<DOMAIN>` + Zertifikatspfade ersetzen, nach `/etc/nginx/sites-available/` kopieren, symlinken, `nginx -t && systemctl reload nginx`.

Wer **NPMplus / Nginx Proxy Manager** nutzt: [deploy/nginx-npmplus.conf](deploy/nginx-npmplus.conf) — die UI-Feldwerte (Forward `http://…:3737`, Cache/HSTS aus) plus den Override-Block für den „Advanced"-Tab des Proxy-Hosts. Der `X-Forwarded-*`-Block darin ist Pflicht, damit die App über `trust proxy` die **echte Client-IP** (`req.ip`) in ihre Audit-/Sicherheits-Logs schreibt statt der Proxy-IP.

Wesentlich: Die App lauscht auf `127.0.0.1:3737`, terminiert kein TLS und liest `X-Forwarded-Proto` (`trust proxy`). SSE braucht ungepufferte Verbindungen (`proxy_buffering off`), und die Kompression macht die App selbst — NGINX-gzip daher aus.

### Optional: veraPDF (PDF/A-Validierung)

Ohne veraPDF läuft die Validierung im Skip-Modus, das PDF wird trotzdem geliefert. Für strikte Validierung:

```bash
apt-get install -y default-jre-headless curl unzip   # oder: apk add openjdk17-jre-headless curl unzip

VERAPDF_VERSION=1.26.2
curl -sSL "https://software.verapdf.org/releases/verapdf-greenfield-${VERAPDF_VERSION}.zip" -o /tmp/verapdf.zip
mkdir -p /opt/verapdf && unzip -q /tmp/verapdf.zip -d /opt/verapdf
cd /opt/verapdf/verapdf-greenfield-${VERAPDF_VERSION}
java -cp installer-${VERAPDF_VERSION}.jar org.verapdf.apps.Installer -options auto-install-options.xml
# /opt/verapdf-installation in PATH oder VERAPDF_BIN setzen
```

### Optional: EPUBCheck (EPUB-Validierung)

Auf Prod erledigt das die Deploy-Migration [deploy/migrations/004-install-epubcheck.sh](deploy/migrations/004-install-epubcheck.sh) automatisch (läuft bei jedem Deploy, idempotent). Ohne EPUBCheck läuft die EPUB-Validierung im Skip-Modus, das EPUB wird trotzdem geliefert. Manuell (W3C-Referenzvalidator, Java):

```bash
# Einfachster Weg: paketverwalteter Wrapper (liefert ein 'epubcheck'-Executable in PATH)
apt-get install -y epubcheck            # oder: apk add epubcheck / brew install epubcheck

# Alternativ ein eigenes Wrapper-Skript anlegen und via EPUBCHECK_BIN referenzieren —
# EPUBCHECK_BIN muss ein aufrufbares Executable sein (kein "java -jar …"-String):
#   #!/bin/sh
#   exec java -jar /opt/epubcheck/epubcheck.jar "$@"
# Deaktivieren ohne Deinstallation: app_settings epub.validate.disabled = true
```

### Optional: GITHUB_TOKEN (Client-Versionen im Profil)

Das Profil (`/me`) zeigt eingeloggten Usern Installationsweg + Version der Clients. Für die **Android-App** ([schreibwerkstatt-mobile](https://github.com/schreibwerkstatt/mobile)) und die **Chrome-Erweiterung** ([schreibwerkstatt-browser-extension](https://github.com/schreibwerkstatt/browser-extension)) liest der Server das `latest`-Release des öffentlichen Repos über die GitHub-Public-API ([lib/github-release.js](../lib/github-release.js), In-Memory-Cache ~10 min). Kein Token nötig. Wird ein GitHub-Token (PAT) hinterlegt, wird es als Bearer mitgeschickt, um das API-Rate-Limit anzuheben (60→5000 Requests/h). Konfiguration: **Admin-Settings → Erweitert → `macclient.github_token`** (verschlüsselt in `app_settings` gespeichert; der Key-Name stammt aus der Zeit des DMG-Downloads). `GITHUB_TOKEN` in `.env` dient nur noch als einmaliger Boot-Seed in die DB.

Die **macOS-App** braucht das Token nicht: sie kommt aus dem [Mac App Store](https://apps.apple.com/app/id6797073919?mt=12), und ihre Version liest der Server aus der öffentlichen iTunes-Lookup-API ([lib/appstore-lookup.js](lib/lib/appstore-lookup.js)).

### Update

```bash
git pull && npm ci --omit=dev && systemctl restart schreibwerkstatt
```

### Node-Major wechseln

Gilt für jeden Major-Sprung innerhalb von `engines` (z. B. 24 → 26), auf Prod wie auf der Demo (dort `/opt/schreibwerkstatt-demo`, User `swdemo`, Dienst `schreibwerkstatt-demo`, kein CI-Stempel). Node kommt aus der NodeSource-Quelle (`/etc/apt/sources.list.d/nodesource.sources`), und **dieselbe** System-Node fährt den Dienst und den self-hosted CI-Runner. Der Runner nimmt seinen `PATH` aus `/opt/actions-runner/.path`, eingefroren bei seiner Installation: steht dort eine nvm-Node aus der root-Shell, laufen CI und das `npm install` in `deploy.sh` (als root) unter **ihr** — der Deploy baut die nativen Module dann für die falsche ABI, und der Dienst startet nicht mehr. `.path` darf darum nur Systempfade tragen, und `.env` kein `NVM_BIN` (Schritt 0). Ein neuer Major hat eine neue Modul-ABI: die nativen Module (`better-sqlite3`, `sharp`) müssen neu gebaut werden, sonst bricht der Start mit `NODE_MODULE_VERSION`-Fehler ab. Die beiden Lockfile-Stempel überspringen den Install aber, solange `package-lock.json` gleich bleibt — darum werden sie von Hand verworfen.

Voraussetzung: ein Release, dessen `engines` den Ziel-Major erlaubt, ist deployt. Schritte als root im Container:

```bash
# 0. Runner-Umgebung prüfen — muss die System-Node finden, keine nvm-Pfade
PATH=$(cat /opt/actions-runner/.path) command -v node   # erwartet /usr/bin/node bzw. /bin/node
grep NVM /opt/actions-runner/.env                        # erwartet: nichts
# sonst: .path auf Systempfade setzen, NVM_BIN aus .env löschen, Runner-Service neu starten (nur ohne laufenden Job: pgrep -x Runner.Worker)

# 1. Sicherung
systemctl start schreibwerkstatt-backup.service

# 2. Quelle umstellen und Node tauschen
sed -i 's/node_24\.x/node_26.x/' /etc/apt/sources.list.d/nodesource.sources
apt-get update && apt-get install -y nodejs
/usr/bin/node -v   # absolut: eine nvm-Node in der root-Shell verdeckt sonst die System-Node

# 3. Native Module der App neu bauen (als App-User, im Installationsziel)
su -s /bin/bash github-runner -c 'cd /opt/schreibwerkstatt && npm rebuild better-sqlite3 sharp'

# 4. Stempel verwerfen — der nächste Deploy bzw. CI-Lauf installiert dann frisch
rm -f /opt/schreibwerkstatt/node_modules/.deployed-lock-sha
rm -f /opt/actions-runner/_work/schreibwerkstatt/schreibwerkstatt/node_modules/.ci-lock-sha

# 5. Neustart und Kontrolle
systemctl restart schreibwerkstatt
journalctl -u schreibwerkstatt -n 30 --no-pager
su -s /bin/bash github-runner -c "cd /opt/schreibwerkstatt && node -e \"require('better-sqlite3');require('sharp');require('playwright').chromium.launch({args:['--no-sandbox']}).then(b=>b.close()).then(()=>console.log('ok'))\""
```

Der nächste Push auf `main` fährt den Runner dann mit `npm ci` unter dem neuen Major. Headless-Chromium hängt an der Playwright-, nicht an der Node-Version und bleibt.

Rückweg: Quelle auf `node_24.x` zurückstellen, `apt-get install -y --allow-downgrades nodejs=24.*`, dann Schritte 3–5 wiederholen.

### Stopp & Neustart

`systemctl stop|restart` schickt SIGTERM; [lib/shutdown.js](lib/shutdown.js) nimmt ab dann nichts Neues mehr an (`503 SHUTTING_DOWN`, Queue gestoppt), beendet SSE-Streams aktiv, lässt laufende Jobs bis 15 s fertig werden (danach Abbruch), schliesst nach spätestens 25 s alle Verbindungen und die DB mit WAL-Checkpoint. Ein gewollter Stopp endet **immer mit Exit 0** (auch wenn eine Frist griff — dann steht ein `WARN` mit der Liste offener Verbindungen, Streams, Jobs und Timer im Log), Exit ≠ 0 nur bei echtem Fehler (DB nicht schliessbar, `uncaughtException`). Darum kein `SuccessExitStatus=1` in der Unit. `TimeoutStopSec=45` liegt über dem 30-s-Hard-Timeout, damit systemd nicht vorher SIGKILL schickt. Die Logzeile `SIGTERM empfangen – Graceful Shutdown (max 30 s Drain)…` bleibt im Wortlaut — das Monitoring zählt sie.

### Logs

Winston schreibt `schreibwerkstatt.log` (current) und rotiert bei 5 MB nach `schreibwerkstatt1.log` … `schreibwerkstatt5.log` — die Ziffer steht **vor** der Endung. Ablageort: `LOG_DIR` (ENV, Default App-Verzeichnis; [lib/log-file.js](lib/log-file.js), von Logger und Admin-Log-Ansicht geteilt). Der CD-Deploy ([deploy/deploy.sh](deploy/deploy.sh)) synchronisiert mit `rsync --delete` und schliesst deshalb `schreibwerkstatt*.log*` aus; empfohlen ist trotzdem ein Verzeichnis ausserhalb des Installationsziels, damit die Historie nicht an einem Exclude-Muster hängt:

```bash
mkdir -p /var/log/schreibwerkstatt && chown github-runner:github-runner /var/log/schreibwerkstatt
echo 'LOG_DIR=/var/log/schreibwerkstatt' >> /opt/schreibwerkstatt/.env
systemctl restart schreibwerkstatt
```

## Backup

Tägliches Online-Backup der SQLite-DB via systemd-Timer (`schreibwerkstatt-backup.timer`, Default 03:00). `sqlite3 .backup` (lock-frei, WAL-konsistent), gzip-komprimiert, Retention nach `mtime`. Pre-Deploy zusätzlicher Snapshot.

Konfig via `.env`: `BACKUP_DIR`, `BACKUP_RETENTION_DAYS`, `BACKUP_DB_FILE`. Script + Units: [deploy/backup.sh](deploy/backup.sh), [deploy/schreibwerkstatt-backup.service](deploy/schreibwerkstatt-backup.service), [deploy/schreibwerkstatt-backup.timer](deploy/schreibwerkstatt-backup.timer).

Backup-Ordner offsite spiegeln (rsync nach NAS/S3) — sonst Single-Point-of-Failure.

### Backup und Wiederherstellen in der Admin-Konsole

Karte «Backup» ([admin-backup.html](../public/partials/admin-backup.html), Routen [routes/admin-backup.js](../routes/admin-backup.js), Logik [lib/db-backup.js](../lib/db-backup.js)):

- **Herunterladen** ist zweistufig: `POST /admin/backup/snapshot` legt einen konsistenten `VACUUM INTO`-Snapshot neben der DB an und liefert ein Einmal-Token (10 min gültig, nur für denselben Admin); `GET /admin/backup/download?token=…` streamt ihn gzip-komprimiert und löscht die Datei. Ein Fehler beim Snapshot steht so als Meldung in der Karte. `GET /admin/backup/download` ohne Token erzeugt und streamt direkt (Skripte).
- **Wiederherstellen** lädt die Datei hoch («Hochladen und vormerken», Body ist die Datei selbst), prüft sie (gzip oder rohes SQLite, `integrity_check`, `foreign_key_check`, Schema-Version nicht neuer als die laufende App) und legt sie als `<DB_FILE>.restore-pending` ab. Eingespielt wird sie beim **nächsten Start** des Prozesses ([db/apply-pending-restore.js](../db/apply-pending-restore.js), vorher Sicherheitskopie `<DB_FILE>.pre-restore-<Zeit>.sqlite`).
- **Eine Vormerkung gilt für jeden nächsten Start, auch einen ungeplanten.** Solange sie liegt, meldet `GET /admin/backup/info` sie (`pending: { bytes, stagedAt }`) und die Karte zeigt einen Hinweis mit «Wiederherstellen & neu starten» und «Vormerkung verwerfen»; «Abbrechen» nach dem Hochladen verwirft ebenfalls. Verwerfen: `DELETE /admin/backup/pending`.
- **Neustart** (`POST /admin/backup/restart`, nach Rückfrage) beendet den Prozess; systemd startet ihn neu. Die Karte erkennt den neuen Prozess an der gewechselten `bootId` aus `/info` — oder an einer Antwort ohne Sitzung (401), weil die wiederhergestellte DB die aktuelle Sitzung meist nicht kennt — und lädt dann neu. Nach drei Minuten ohne neuen Prozess meldet sie den Zeitüberschritt.
