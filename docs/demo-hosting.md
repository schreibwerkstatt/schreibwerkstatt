# Demo-Zugang & Testinstanz-Hosting

Anleitung zur Einrichtung und Verwaltung einer dedizierten Demo-Instanz (für Store-Reviews, Testläufe etc.).

## Demo-Zugang (Store-Reviews, Testinstanz)

Dritter Login-Pfad neben Google-OIDC und Admin-Passwort: ein **fixer Passwort-Login mit Rolle `user`**. Existenzgrund sind die App-Store-Reviews — Apple (Guideline 2.1, Feld „Sign-in required") und Google Play (`App access`) verlangen einen funktionierenden Demo-Account als Pflichtangabe, der Chrome Web Store Test-Credentials in den Reviewer-Notes. Ein Google-Konto lässt sich Reviewern nicht geben (2FA, Googles ToS, Login-Blocks aus Datacenter-IPs), und der Admin-Pfad würde `/admin/*` und fremde Bücher freigeben.

Vollständig kommentierte Vorlage mit allen Variablen: **[.env.demo.example](.env.demo.example)** (nicht `.env.example` — das ist die Prod-Vorlage ohne Demo-Pfad). Sie ist gleichzeitig die Vorlage, aus der [deploy/install-demo.sh](deploy/install-demo.sh) generiert; wer eine Variable ergänzt, tut es dort und nirgends sonst.

Aktivierung ausschliesslich über `.env` — fehlt eines der beiden, existiert der Pfad nicht:

```bash
DEMO_EMAIL=demo@example.com
DEMO_PASSWORD=<langes Zufallspasswort>
```

Verhalten ([lib/demo-user.js](lib/lib/demo-user.js), Route `POST /auth/demo-login` in [routes/auth.js](routes/auth.js)):

- **Rolle ist immer `user`**, kein Invite-Recht. Wird die Row von Hand auf `admin` gehoben, drückt sie der nächste Demo-Login zurück — der Zugang ist öffentlich bekannt.
- **Gleiche Härtung wie der Admin-Login** (geteilte Factory: Rate-Limit pro IP, ALTCHA, timing-safe Vergleich, Audit-Event mit `method: 'demo'`) und **derselbe IP-Bucket** — Brute-Force gegen den einen Pfad deckelt auch den anderen.
- **Beispielbuch wird bei jedem Login geseedet** (idempotent über den Buchnamen, gemeinfreie Prosa, kein KI-Call). Ein Reviewer landet nie in einer leeren App, auch wenn der vorige alles gelöscht hat.
- **Dazu ein zweites Buch „Fremdes Buch"**, das einem erfundenen `example.org`-Konto gehört und auf dem der Demo-User nur `viewer` ist ([lib/demo-book.js](lib/lib/demo-book.js)#`createForeignDemoBook`, idempotent über die Besitz-Row). **Why:** die Store-Prüfung der Browser-Erweiterung soll sehen, dass ein fehlendes Recht *benannt* wird — auf diesem Buch antwortet der Server `403 INSUFFICIENT_ROLE` mit `detail: { actual: 'viewer', required: 'editor' }` statt stumm zu scheitern. Die Besitzer-Adresse muss auf `example.org` liegen: `GET /content/books` gibt `owner_email` heraus und der Prüfer sieht die Antwort. Details in [docs/clients.md](docs/clients.md).
- **Status-Gate greift:** `suspended`/`deleted` im Admin-Tab → `403 USER_NOT_ACTIVE`. So lässt sich der Zugang ohne ENV-Änderung stilllegen.
- **`DEMO_EMAIL === ADMIN_EMAIL` deaktiviert den Demo-Pfad** (sonst streiten sich beide Routen um die Rolle derselben Row).

### Fixe Device-Tokens für die Clients

Die nativen Clients (macOS/Android) und die Browser-Erweiterung authentisieren per Bearer-Token und sehen die Login-Seite nie — ein Reviewer müsste sich sonst erst im Browser einloggen, im Profil ein Token minten und es in die App kopieren. Darum lassen sich beide Token-Arten in der ENV festnageln:

```bash
DEMO_DEVICE_TOKEN=swd_$(openssl rand -hex 32)    # macOS + Android (content:write)
DEMO_CAPTURE_TOKEN=swd_$(openssl rand -hex 32)   # Chrome-Erweiterung (capture:write)
```

Der Klartext gehört danach in die Store-Reviewer-Notes (zusammen mit der Server-URL); die DB kennt weiter nur den SHA-256-Hash. Registriert werden sie beim **Serverstart** ([lib/demo-user.js](lib/lib/demo-user.js)#`ensureDemoAccess`, aufgerufen in [server.js](server.js)) — nicht erst beim ersten Login, denn genau diese Clients loggen sich nie über den Browser ein. Die Scopes folgen den bestehenden Token-Arten aus [lib/device-scopes.js](lib/lib/device-scopes.js); der Demo-Zugang bekommt damit **keine** Sonderrechte, die Erweiterung bleibt auf die Capture-Allowlist beschränkt.

- **Format ist Pflicht:** `swd_` + 64 Hex-Zeichen. Ein formal ungültiger Wert wird abgelehnt und **nicht** registriert (Log-Error) — sonst wandert ein `swd_test` als vollwertiger Schreibzugang auf eine öffentlich erreichbare Instanz.
- **Rotation entzieht wirklich:** neuer Wert in derselben Variable + Neustart → das alte Token gilt nicht mehr (der Slot wird über den `device_name` identifiziert und aufgeräumt).
- **Nicht über die UI entziehbar:** die Tokens erscheinen im Demo-Profil wie jedes andere Gerät, aber Widerrufen/Löschen antwortet `403 DEMO_TOKEN_FIXED` — sonst schaltet ein neugieriger Reviewer den Zugang für alle folgenden ab. Entzogen wird über die ENV.
- **Beide Slots brauchen unterschiedliche Werte** (`token_hash` is UNIQUE — derselbe Wert in beiden würde die Scopes des ersten überschreiben). Wird das verletzt, bleibt der zweite Slot unregistriert.
- Sichtbar im Admin-Tab „Geräte" unter `Demo-Client (macOS/Android)` bzw. `Demo-Erweiterung (Chrome)` — inkl. `last_used_at` und gemeldeter Client-Version, sodass man sieht, ob ein Reviewer die App tatsächlich gestartet hat.

Ein Token teilt sich macOS und Android bewusst (dasselbe Device-Token darf laut [docs/clients.md](docs/clients.md) auf mehreren Geräten laufen, `X-Client-Platform` unterscheidet sie zur Laufzeit). Wer die beiden trennen will, ergänzt einen weiteren Slot in `TOKEN_SLOTS` ([lib/demo-user.js](lib/lib/demo-user.js)).

> **Nur auf einer separaten Demo-Instanz setzen, nie auf Prod.** Reviewer schreiben, und KI-Jobs kosten Geld. Das Setup-Script unten richtet genau so eine Instanz ein (eigene DB, eigener Service, Budget-Cap, nächtlicher Reset); den KI-Provider wählt man danach in der Admin-Konsole.

## Demo-Instanz aufsetzen (LXC)

[deploy/install-demo.sh](deploy/install-demo.sh) ist das Pendant zu [deploy/install.sh](deploy/install.sh) und läuft genauso **im Container** aus einem Repo-Checkout. Es kann neben einer Prod-Installation auf demselben Host laufen — eigenes Verzeichnis (`/opt/schreibwerkstatt-demo`), eigener Service (`schreibwerkstatt-demo`), eigener Port (3738), eigener System-User (`swdemo`, nicht der CD-Runner).

```bash
# Im Container, als root, aus dem Checkout:
bash deploy/install-demo.sh --domain demo.example.com
```

Der `pct create`-Aufruf zum Anlegen des LXC steht als Kommentar im Kopf des Scripts. Überschreibbar per Env-Var: `INSTALL_DIR`, `SERVICE`, `PORT`, `RUN_USER`, `DEMO_BUDGET_USD`. Optional `--with-export-tools` für veraPDF/Ghostscript/ICC/EPUBCheck (~200 MB inkl. JRE) plus das Headless-Chromium des serverseitigen Diagramm-Renderings (~170 MB); ohne das laufen PDF-/EPUB-Export weiterhin, nur ohne Normvalidierung, und Diagramme erscheinen im Export als Quelltext (am Bildschirm rendert der Client-Bundle).

Was das Script tut:

1. Node 22 (LTS) + `sqlite3`-CLI (letzteres ist hier **Pflicht**, nicht optional wie auf Prod — Snapshot und Reset laufen darüber), System-User, Dateien, `npm install --omit=dev`.
2. **Generiert die `.env` aus [.env.demo.example](.env.demo.example)** — die Vorlage ist die SSoT des ENV-Layouts, der Installer ersetzt nur die `__PLATZHALTER__` durch frische Zufallswerte (`SESSION_SECRET`, Admin-Passwort, Demo-Passwort, beide Device-Tokens im `swd_`-Format). Bleibt ein Platzhalter stehen, bricht er ab statt eine Instanz mit 18-Zeichen-„Secret" zu starten. **Eine bestehende `.env` wird nie überschrieben** — sonst würden bei einer Neuinstallation die Zugangsdaten rotieren, die bereits bei Apple/Google eingetragen sind, und das Review scheitert an einem Login-Fehler.
3. Installiert Service + **Reset-Timer** (04:30 lokal, nach dem Nacht-Cron der App) statt des Backup-Timers.
4. Wartet, bis die App antwortet — erst dann existieren Demo-User, Device-Tokens und Beispielbuch (Boot-Bootstrap) —, setzt `app.public_url` und das **Monatsbudget des Demo-Users** (Default 5 USD, `mode: hard`), und schreibt den **Golden-Snapshot** fest.
5. Gibt den **Credential-Block für die Store-Formulare** aus. Erneut abrufbar mit `bash deploy/install-demo.sh --print-credentials` (rotiert nichts).

Reverse-Proxy: dieselbe Konfiguration wie Prod ([deploy/nginx.conf](deploy/nginx.conf) bzw. [deploy/nginx-npmplus.conf](deploy/nginx-npmplus.conf)), nur `<DOMAIN>` = Demo-Domain und Upstream-Port 3738. **TLS ist Pflicht** — Apples App Transport Security lässt einen nativen Client sonst nicht gegen den Server sprechen.

### Was auf der Demo-Instanz bewusst offen ist

Die Zugangsdaten stehen in Store-Formularen und sind damit öffentlich. Wer sie hat, hat einen vollwertigen `user`-Account: Bücher schreiben und löschen, Dateien hochladen (Cover bis 20 MB, Recherche-Anhänge), Inhalte über Share-Links öffentlich unter der Demo-Domain stellen (`noindex,nofollow`, siehe [docs/share-link.md](docs/share-link.md)) und sich eigene Device-Tokens ausstellen. Das ist Absicht — genau das soll ein Reviewer können. Eingegrenzt wird es durch die Trennung (eigener Container, eigene DB, eigenes `SESSION_SECRET`, Rolle nie `admin`), das Monatsbudget und den nächtlichen Reset, der alles davon zurücknimmt.

Zwei Dinge, die der Reset **nicht** abdeckt und die darum auf Infrastruktur-Ebene gehören:

- **Netz-Isolation des Containers.** Alles, was die App an ausgehenden Requests macht, macht sie aus diesem Container heraus — ein öffentlich bekannter Account ist damit ein Fuss im internen Netz. Anwendungsseitig ist der eine user-kontrollierte Pfad (Bild-URLs im Manuskript, geholt beim PDF-Export) über [lib/ssrf-guard.js](lib/lib/ssrf-guard.js) geschlossen, ebenso die Blog-Connection. Verlassen sollte man sich darauf nicht: die Demo-LXC gehört in ein Segment, aus dem Prod und die Management-Oberflächen **nicht** erreichbar sind. **Achtung beim Egress-Filter:** eine pauschale Regel gegen RFC-1918-Ziele trifft auch den DNS-Resolver, wenn der das Default-Gateway ist — Resolver vorher auf einen öffentlichen Dienst umstellen oder die Regel um seine Adresse ausnehmen, sonst löst die Instanz keinen Namen mehr auf.
- **Anfragen-Rate.** Innerhalb der App gibt es Rate-Limits nur für Login, Registrierung und Share-Reader; ein authentifizierter Aufrufer kann also Requests und Analyse-Jobs in beliebiger Zahl absetzen (parallel laufen davon `jobs.max_concurrent`, Default 2). Auf einer 2-Core-Demo genügt das, um sie unbenutzbar zu machen. Gehört an den Reverse-Proxy, nicht in die App — und **nicht** in die geteilte [deploy/nginx.conf](deploy/nginx.conf), sondern in den Demo-Vhost: die SPA pollt Job-Status und Presence im Sekundenbereich, eine zu knappe Zone bricht ihr die Live-Updates. Grosszügig ansetzen und beobachten:

  ```nginx
  # http-Block:
  limit_req_zone $binary_remote_addr zone=swdemo:10m rate=20r/s;
  # server-Block der Demo-Domain:
  limit_req zone=swdemo burst=200 nodelay;
  limit_conn_zone $binary_remote_addr zone=swdemoconn:10m;
  limit_conn swdemoconn 24;
  ```

### Reset-Mechanik

[deploy/demo-reset.sh](deploy/demo-reset.sh) hält einen **Golden-Snapshot** und setzt die Instanz darauf zurück. Ohne das sieht Reviewer Nr. 2 die Textreste von Nr. 1 — im schlimmsten Fall ein leeres Buch, weil Nr. 1 alles gelöscht hat.

```bash
bash deploy/demo-reset.sh capture   # aktuellen Stand als Ziel festschreiben (Service darf laufen)
bash deploy/demo-reset.sh reset     # DESTRUKTIV: Service stoppen, Snapshot einsetzen, starten
bash deploy/demo-reset.sh status    # Snapshot-Alter, Marker, Service- und Timer-Zustand
```

`capture` nutzt `sqlite3 .backup` (lock-frei, WAL-konsistent) und schwenkt die Datei atomar ein. `reset` löscht `-wal`/`-shm` mit — bleiben sie liegen, mischt SQLite die alten Transaktionen über die frisch eingesetzte DB und der Reset ist teilweise wieder aufgehoben. Nach jeder bewussten Verbesserung des Demo-Inhalts erneut `capture` aufrufen, sonst fällt die Nacht den Fortschritt wieder ab.

`reset` verlangt **zwei** Bedingungen, sonst bricht es ab: die Marker-Datei `.demo-instance` neben der Live-DB **und** ein gesetztes `DEMO_EMAIL` in der `.env`. **Why:** das Script überschreibt eine Datenbank; ein versehentlicher Aufruf gegen `/opt/schreibwerkstatt` wäre der teuerste mögliche Fehler, und je einzelnes Kriterium wäre zu leicht erfüllt (der Marker kann mitkopiert werden, `DEMO_EMAIL` steht auch in einer Entwickler-`.env`). Fehlt der Golden-Snapshot, bricht es **vor** dem `systemctl stop` ab — sonst stünde die Demo still.

## CD: Demo-Instanz automatisch aktuell halten

Die Demo bekommt bei jedem grünen `main`-Push denselben Stand wie Prod. Beide Deploys hängen an denselben Test-Jobs, laufen aber **unabhängig** (kein `needs` zwischen ihnen): ein Prod-Fehler darf die Demo nicht auf einem alten Stand einfrieren, und umgekehrt.

Mechanik: ein **zweiter self-hosted Runner** auf der Demo-LXC, adressiert über das Label `demo`. Der Job `deploy-demo` in [.github/workflows/deploy.yml](.github/workflows/deploy.yml) ruft dasselbe [deploy/deploy.sh](deploy/deploy.sh) auf wie Prod, nur mit `SW_FLAVOUR=demo`.

**Einrichtung** (einmalig, auf der Demo-LXC, nach `install-demo.sh`):

1. **Label am bestehenden Runner nachtragen.** Zuerst, nicht danach: sobald ein zweiter Runner im Repo hängt, matcht ein blosses `runs-on: self-hosted` **beide** — die Testjobs würden auf der Demo-LXC landen und der Prod-Deploy dort ins Leere laufen. Der Prod-Runner braucht darum das Label `prod` (GitHub → Settings → Actions → Runners → Labels; kein Neu-Registrieren nötig), passend zu den `runs-on: [self-hosted, prod]` im Workflow.
2. **Runner auf der Demo-LXC registrieren** via [deploy/install-runner.sh](deploy/install-runner.sh) (als root, aus dem Checkout):

   ```bash
   # Token holen (gilt eine Stunde) — lokal, mit gh:
   gh api -X POST repos/schreibwerkstatt/schreibwerkstatt/actions/runners/registration-token --jq .token

   # auf der Demo-LXC:
   bash deploy/install-runner.sh --token <TOKEN> --label demo --name schreibwerkstatt-demo
   ```

   Das Script installiert die Systempakete, lädt das neueste Runner-Release passend zur Architektur, zieht dessen .NET-Abhängigkeiten (`libicu` — fehlt auf einem minimalen Debian-LXC und der Runner stirbt sonst mit einem Globalization-Fehler, der nicht nach fehlendem Paket aussieht), registriert und richtet den systemd-Service ein. Weiter: `--status`, `--uninstall`, `--force` (neu registrieren), `--version` (Release pinnen). Der Runner läuft **als root**, weil `deploy.sh` `systemctl`, `/etc/systemd/system` und `chown` ohne `sudo` benutzt — dieselbe Annahme wie auf Prod; `RUNNER_ALLOW_RUNASROOT` setzt das Script als systemd-Drop-in, damit es eine Neuinstallation des Service überlebt.

   Nur das Zusatz-Label angeben: `self-hosted`, `Linux` und `X64` vergibt GitHub selbst. **Kein** Playwright nötig — auf der Demo-LXC laufen keine Tests.
3. Fertig. `SW_INSTALL_DIR`/`SW_SERVICE`/`SW_OWNER`/`SW_PORT` stehen im Job-`env` und müssen zu den Werten der Installation passen — wer die Demo mit abweichendem `INSTALL_DIR` installiert hat, zieht sie dort nach.

Was der Demo-Deploy **anders** macht als Prod (alles in `deploy.sh` am `SW_FLAVOUR` aufgehängt, damit kein zweites Deploy-Skript daneben driftet):

- **Kein DB-Backup vorher** — der Golden-Snapshot ist die Sicherung. Ein `capture` an dieser Stelle wäre sogar schädlich: es würde festschreiben, was der letzte Reviewer hinterlassen hat.
- **Zusätzliche rsync-Excludes** für `demo-golden.db`, `.demo-instance` und `.with-export-tools`. **Why:** diese Dateien leben im Installationsverzeichnis, stehen aber nicht im Repo — ohne Exclude räumt `--delete` sie beim ersten Deploy weg, und `demo-reset.sh` verweigert danach jeden Reset, weil sein Marker-Guard fehlt.
- **Reset-Timer statt Backup-Timer**, Units über [deploy/demo-units.sh](deploy/demo-units.sh) (geteilte SSoT mit `install-demo.sh` — sonst zwei sed-Blöcke mit derselben heiklen Ersetzungsreihenfolge).
- **Deploy-Migrations nur mit Marker:** die Scripts unter `deploy/migrations/` installieren veraPDF/Ghostscript/EPUBCheck (~200 MB inkl. JRE). Auf einer bewusst schlanken Demo laufen sie nur, wenn `install-demo.sh --with-export-tools` den Marker `.with-export-tools` gesetzt hat. **Dasselbe Gate hält das Headless-Chromium** des serverseitigen Diagramm-Renderings (~170 MB) von der Demo fern — dort fällt die Leseansicht auf den mermaid-Client-Bundle zurück, siehe [docs/diagramme.md](docs/diagramme.md).

**Der Golden-Snapshot altert mit dem Schema und wird nie automatisch neu aufgenommen.** Ein Reset setzt eine DB mit älterer `schema_version` ein; die Migrationen laufen beim nächsten Serverstart erneut durch, das ist unkritisch. Aber der *Inhalt* bleibt auf dem Stand des letzten `capture` — nach jeder bewussten Verbesserung des Demo-Inhalts (und vor einer Store-Einreichung) einmal `bash deploy/demo-reset.sh capture` aufrufen. Der Job gibt am Ende `demo-reset.sh status` aus, damit man das Alter im Actions-Log sieht.
