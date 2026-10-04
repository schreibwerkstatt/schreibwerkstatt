# Deployment & Selbst-Hosting

Ausführliche Anleitung für den Betrieb und das Selbst-Hosting von Schreibwerkstatt.

## Voraussetzungen

- Node.js v22–25 (`engines: >=22 <26`; Node 20 ist EOL, und `npm test` übergibt Globs an `node --test` (erst ab Node 21); Node 26 noch nicht unterstützt: better-sqlite3 11.x baut nicht gegen das V8 in Node 26 — Bump auf 12.x ausstehend). Empfohlen: `.nvmrc` (Node 24).
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

Das Profil (`/me`) zeigt eingeloggten Usern Installationsweg + Version der Clients. Für die **Android-App** ([schreibwerkstatt-mobile](https://github.com/schreibwerkstatt/mobile)) und die **Chrome-Erweiterung** ([schreibwerkstatt-browser-extension](https://github.com/schreibwerkstatt/browser-extension)) liest der Server das `latest`-Release des öffentlichen Repos über die GitHub-Public-API ([lib/github-release.js](lib/lib/github-release.js), In-Memory-Cache ~10 min). Kein Token nötig. Wird ein GitHub-Token (PAT) hinterlegt, wird es als Bearer mitgeschickt, um das API-Rate-Limit anzuheben (60→5000 Requests/h). Konfiguration: **Admin-Settings → Erweitert → `macclient.github_token`** (verschlüsselt in `app_settings` gespeichert; der Key-Name stammt aus der Zeit des DMG-Downloads). `GITHUB_TOKEN` in `.env` dient nur noch als einmaliger Boot-Seed in die DB.

Die **macOS-App** braucht das Token nicht: sie kommt aus dem [Mac App Store](https://apps.apple.com/app/id6797073919?mt=12), und ihre Version liest der Server aus der öffentlichen iTunes-Lookup-API ([lib/appstore-lookup.js](lib/lib/appstore-lookup.js)).

### Update

```bash
git pull && npm ci --omit=dev && systemctl restart schreibwerkstatt
```

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
