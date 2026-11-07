# Anmeldung

Wie sich ein Mensch an dieser Instanz anmeldet, ist eine Einstellung: `auth.method`.
Genau **ein** Verfahren ist aktiv. Daneben — und von dieser Wahl unberührt — stehen
zwei ENV-Pfade, die es aus eigenem Grund gibt.

| Weg | Wann | Konfiguration |
|---|---|---|
| **Google** (OIDC) | `auth.method='google'` | `auth.google.client_id`, `auth.google.client_secret`, `app.public_url` |
| **Lokal** (E-Mail + Passwort) | `auth.method='local'` | `auth.local.*` (siehe unten) |
| **ENV-Admin** | immer, wenn `ADMIN_EMAIL` + `ADMIN_PASSWORD` gesetzt sind | ENV |
| **Demo-Zugang** | immer, wenn `DEMO_EMAIL` + `DEMO_PASSWORD` gesetzt sind | ENV, [lib/demo-user.js](../lib/demo-user.js) |

**Why genau eines:** das Anmeldeverfahren ist eine Eigenschaft der Instanz, keine
Auswahl des Besuchers. Zwei parallele Wege auf dieselbe Adresse wären zwei
Wahrheiten über ein Konto — dieselbe Person könnte sich einmal mit Google und
einmal mit Passwort anmelden, und die Frage „wer darf dieses Konto benutzen" hätte
zwei Antworten, die niemand synchron hält.

**Why die ENV-Pfade trotzdem daneben:** der ENV-Admin ist der Notfall-Zugang. Er
muss auch dann tragen, wenn das gewählte Verfahren gerade nicht funktioniert —
falsch gesetzte Client-ID, ausgefallener IdP, leergelaufenes Zertifikat. Der
Demo-Zugang existiert, weil Store-Reviews einen Testzugang verlangen und man
Prüfern kein Google-Konto geben kann.

## Wo der Code liegt

```
routes/auth/
  index.js               Facade: Schale, dahinter die Provider-Router
  shell.js               /login · /auth/logout · /auth/avatar · /invite/:token · ENV-Pfade
  render.js              SSR-Bausteine der Pre-Auth-Seiten (Schale, Formular, Hinweisseite)
  credential-login.js    geteilter Kern JEDER Passwort-Anmeldung
  async-route.js         Rejection-Wrapper (Log mit Routen-Label, 500 INTERNAL_ERROR)
  providers/
    index.js             Registry + Vertrag
    google.js            OIDC
    local.js             E-Mail + Passwort
```

Dazu: [lib/password.js](../lib/password.js) (scrypt-Hashing), [db/user-credentials.js](../db/user-credentials.js)
(Hash + Einmal-Tokens), [lib/public-url.js](../lib/public-url.js) (Basis-URL für Links).

## Ein weiteres Verfahren ergänzen

Ein Verfahren ist **eine Datei plus zwei Zeilen**. Weder die Login-Seite noch der
Auth-Guard in [lib/auth-guard.js](../lib/auth-guard.js) noch das Admin-UI müssen dafür angefasst werden.

1. Modul unter `routes/auth/providers/` anlegen, das den Vertrag erfüllt:

   | Feld | Bedeutung |
   |---|---|
   | `id` | Kennung, identisch mit dem Wert in `auth.method` |
   | `router` | Express-Router mit den eigenen Endpunkten |
   | `isConfigured()` | Hat der Admin alles gesetzt, was das Verfahren braucht? |
   | `configKeys` | zugehörige Settings-Keys (Admin-UI + Test) |
   | `inviteRedirect(token)` | wohin führt ein angeklickter Einladungslink? |
   | `renderLoginBlock({ t, returnTo })` | Block auf der Login-Seite (HTML-String) |
   | `loginScripts()` | zusätzliche `<script>`-Tags für diesen Block |

2. Eintrag in `PROVIDERS` ([routes/auth/providers/index.js](../routes/auth/providers/index.js)).
3. Wert in die `oneOf`-Liste von `auth.method` ([lib/app-settings/keys/auth.js](../lib/app-settings/keys/auth.js)).

Registry und `oneOf` sind zwei Listen über dieselbe Sache; [tests/unit/auth-providers.test.js](../tests/unit/auth-providers.test.js)
macht CI rot, sobald sie auseinanderlaufen, und prüft den Vertrag jedes Moduls.

Der Router eines Verfahrens läuft **nur, solange es aktiv ist** — die Registry
mountet jeden hinter ein Gate auf `auth.method`. Ein Endpunkt eines inaktiven
Verfahrens antwortet 404; ein eigenes `isActive`-Gate im Provider ist darum
weder nötig noch erwünscht.

## Lokale Anmeldung

### Einstellungen

| Key | Default | Bedeutung |
|---|---|---|
| `auth.local.min_password_length` | 12 | Untergrenze für neue Passwörter |
| `auth.local.token_ttl_hours` | 48 | Gültigkeit eines Setz-/Reset-Links |
| `auth.local.allow_self_reset` | true | „Passwort vergessen" als Selbstbedienung |

Bewusst **keine Zeichenklassen-Pflicht**: erzwungene Sonderzeichen verschieben
Passwörter Richtung `Passwort1!` und machen sie nicht schwerer zu raten. Länge
ist die Schraube, die wirkt.

### Wie ein Konto zu seinem Passwort kommt

Drei Wege, ein Ergebnis — sie unterscheiden sich nur darin, ob das Konto schon
existiert und wer den Anstoss gibt.

1. **Einladung.** Der Admin lädt ein (`POST /admin/users/invite`, unverändert).
   Der Einladungslink führt bei lokalem Verfahren direkt auf `/auth/password?invite=…`.
   Das Konto entsteht **erst beim Setzen des Passworts**, nicht beim Einladen.
2. **Setz-/Reset-Link.** `POST /admin/users/:email/password-link` stellt ein
   Einmal-Token aus und mailt es. Die URL kommt in der Antwort mit zurück, damit
   der Admin sie von Hand weitergeben kann, wenn kein Mailversand konfiguriert ist.
3. **Initialpasswort.** `POST /admin/users/:email/password` setzt ein Passwort mit
   `must_change=1`. Die nächste Anmeldung damit gelingt, **öffnet aber keine
   Sitzung**: der Server mintet ein einstündiges Token und antwortet
   `{ ok: true, redirect: '/auth/password?token=…' }`.

**Why keine halb angemeldete Sitzung beim Initialpasswort:** die müsste ein
globaler Guard danach wieder einfangen, und jede Route, die das vergisst, wäre
ein offenes Konto. Ein kurzlebiges Token trägt den Wechsel stattdessen sichtbar
im Request.

### Invarianten

- **Einmal-Tokens liegen nur als SHA-256-Hash in der DB.** Aus einem Leak lässt
  sich kein gültiger Link bauen.
- **Ein neuer Link entwertet alle offenen Links desselben Kontos.** Sonst bliebe
  eine abgefangene ältere Mail bis zu ihrem Ablauf gültig.
- **Nach dem Setzen werden alle übrigen offenen Links entwertet.** Ein zweiter,
  älterer Reset-Link darf das gerade gesetzte Passwort nicht wieder aushebeln.
- **Unbekannte Adressen kosten dieselbe Zeit wie bekannte.** Der Login rechnet
  gegen einen festen Dummy-Hash weiter, statt früh auszusteigen — sonst wird die
  Antwortzeit zum Adress-Orakel.
- **`POST /auth/forgot` antwortet immer 202 mit demselben Körper** — unbekannt,
  gesperrt, nie lokal angemeldet: dieselbe Antwort.
- **Hash-Parameter stehen im Hash-String.** Ein angehobener Kostenfaktor muss
  bestehende Hashes weiter verifizieren; `needsRehash` meldet, welche beim
  nächsten erfolgreichen Login neu gerechnet gehören. Gegated durch
  [tests/unit/password-hash.test.js](../tests/unit/password-hash.test.js).

### Härtung

Alle Passwort-Anmeldungen — lokal, ENV-Admin, Demo — laufen durch **eine**
Sequenz in [routes/auth/credential-login.js](../routes/auth/credential-login.js):

```
Rate-Limit → ALTCHA → Prüfung der Zugangsdaten → Audit → Sitzung
```

Der Rate-Limit-Bucket ist geteilt (Key = IP, [lib/admin-login-ratelimit.js](../lib/admin-login-ratelimit.js)):
Brute-Force gegen den einen Pfad deckelt auch die anderen. `/auth/password` und
`/auth/forgot` zählen in denselben Bucket — wer Tokens durchprobiert, deckelt
sich damit den Login-Pfad.

**Why eine Sequenz:** drei Kopien würden bei jeder Änderung am Fehler-Handling
auseinanderlaufen, und die Stelle, an der das auffällt, ist die, an der es zu
spät ist. Nur die Prüfung der Zugangsdaten ist pro Pfad verschieden; sie wird
als `authenticate`-Funktion hineingereicht.

## Audit-Spur

`user_sessions_audit.event` kennt für diesen Bereich: `login`, `logout`,
`login-denied`, `password-set`, `password-removed`, `password-link-sent`,
`password-reset-requested`. `meta_json` trägt das Verfahren (`method: 'oidc' | 'local' | 'env' | 'demo'`)
und bei Admin-Eingriffen den Handelnden (`by`).

Die Spalte ist ein CHECK-Constraint, kein Freitext — ein neues Ereignis braucht
eine Migration mit Table-Recreate (SQLite kann die Aufzählung nicht per ALTER
erweitern). Ohne den Wert bricht der Schreibversuch die ganze Transaktion ab.

## Verfahren wechseln

Das Umschalten in der Admin-Konsole (Einstellungen → Anmeldung) ist sofort wirksam,
ohne Neustart. Was dabei zu bedenken ist:

- **Bestehende Sitzungen bleiben.** Wer angemeldet ist, bleibt es; erst die nächste
  Anmeldung nimmt den neuen Weg.
- **Konten bleiben, Anmeldewege nicht.** Nach dem Wechsel auf „Lokal" hat noch kein
  Konto ein Passwort — der Admin verteilt Setz-Links oder Initialpasswörter, bevor
  er den alten Weg abschaltet. Der ENV-Admin ist in diesem Fenster der Rückweg.
- **Google-Secrets bleiben gesetzt.** Das Admin-UI blendet die Felder des inaktiven
  Verfahrens nur aus; ein Zurückschalten verliert nichts.
- **`user_credentials` bleibt beim Wechsel zurück zu einem IdP stehen.** Die Zeilen
  sind harmlos (kein Anmeldeweg ist offen, solange `auth.method` nicht `local` ist),
  und ein erneutes Umschalten findet die Passwörter wieder vor.
