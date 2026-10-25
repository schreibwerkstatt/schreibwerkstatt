# Bild-Generierung im Buch-Chat (self-hosted)

Erzeugt Bilder (Figurenporträt, Schauplatz, Szene, Stimmung) aus dem **agentischen Buch-Chat** heraus. Self-hosted, vom Betreiber konfigurier- und abschaltbar.

**App-Philosophie (KI rückwärtsgewandt):** das Bild ist reine Weltaufbau-/Chat-Visualisierung. Es landet **nie** im Manuskript-Text, sondern nur im Chat-Verlauf — dort ansehbar und herunterladbar.

**Bewusste Ausnahme zum Buch-Chat-Tool-Vertrag** (sonst „Read-Only, deterministisch, kein KI-Call", siehe [chat-tools.md](chat-tools.md)): `generate_image` hat einen Seiteneffekt + externen Call. Es gibt **kein Bild** in den Tool-Loop zurück (Binärdaten passen nicht in den JSON-Loop), sondern nur Metadaten; das Bild lebt in `chat_images` und wird separat gestreamt.

## Datenfluss

```
Buch-Chat (agentisch, nur ai.provider=claude) → Modell ruft Tool generate_image{prompt, size?}
  → lib/image-gen.js → POST ${image.host}/v1/images/generations  (OpenAI-kompatibel)
      { prompt, n:1, size, response_format:"b64_json", model? }
    → { data:[{ b64_json }] }  (oder { url } → Bild wird nachgeladen)
      → BLOB in chat_images (FK chat_sessions, CASCADE)
        → image_id sammelt der Loop in ctx.images → context_info.images der Antwort
          → Frontend rendert das Bild unter der Antwort, Download via GET /chat/image/:id
```

## Backend

- **[lib/image-gen.js](../lib/image-gen.js)** — `generateImage({ prompt, size, signal })`. Eigener Binär-Call-Pfad neben `lib/ai.js#callAI` (das nur JSON liefert). Host/Model/Key aus App-Settings, `/v1`-Suffix wird gestrippt. Decodet `b64_json`, sonst `url`-Fallback (lädt das Bild nach, mime aus `Content-Type`). Timeout aus `image.timeout_ms` + Job-`signal` verknüpft. Fehler als `ImageGenError` mit `code` (`image_disabled`/`image_no_prompt`/`image_upstream`/`image_timeout`/`image_empty`).
- **[routes/jobs/chat-tools/tools-image.js](../routes/jobs/chat-tools/tools-image.js)** — Tool `generate_image`. Persistiert via `db/chat-images.js`, pusht `{image_id,prompt,mime}` in `ctx.images`, gibt JSON-Metadaten + Hinweis zurück (kein Bild, keine URL).
- **[routes/jobs/chat.js](../routes/jobs/chat.js)** `runBookChatJobAgent` — `ctx.sessionId`/`ctx.images` gesetzt; `generate_image` wird **nicht angeboten** (`AVAILABILITY` in [chat-tools/index.js](../routes/jobs/chat-tools/index.js)), solange `image.enabled`+`image.host` fehlen (spart Input-Tokens, totes Werkzeug vermieden); `context_info.images` persistiert.
- **[routes/chat.js](../routes/chat.js)** — `GET /chat/image/:id` streamt das BLOB (Owner-Check via Session-Join), `?download=1` erzwingt den Speichern-Dialog. CSP: same-origin, `img-src 'self'` deckt es (kein CSP-Eintrag nötig).
- **[routes/admin-settings.js](../routes/admin-settings.js)** — `POST /admin/settings/test-image` (Health-Probe `GET /v1/models`).
- **[lib/app-settings.js](../lib/app-settings.js)** — Keys: `image.enabled`, `image.host`, `image.model`, `image.size`, `image.timeout_ms` (5000–600000), `image.api_key` (`ENCRYPTED_KEYS`). **Kein** `/config`-Eintrag (Secret-Leck-Schutz; das Tool läuft rein serverseitig).
- **[db/chat-images.js](../db/chat-images.js)** + Migration 216 — Tabelle `chat_images` (BLOB, FK `chat_sessions` CASCADE).

## Frontend

- **[public/partials/chat.html](../public/partials/chat.html)** — unter jeder Assistant-Nachricht: `msg.context_info.images` → `<figure class="chat-image">` mit `<img :src="'/chat/image/'+id">` + Download-Link. `prompt` via `x-text`/`:alt`/`:data-tip` (Attribut-Bindings escapen automatisch — kein `x-html`-Sink).
- **[public/css/chat.css](../public/css/chat.css)** — `.chat-images`/`.chat-image` (max 320 px, eckige Ecken, Mobile = volle Breite).
- **[public/partials/admin-settings.html](../public/partials/admin-settings.html)** — Admin-Tab „Bilder" (enabled, Host, Modell, Größe, Timeout, API-Key-Masking, Test-Button).

## Endpunkt einrichten (Beispiel-Configs)

Die App spricht **ausschliesslich** das OpenAI-Image-Protokoll: `POST ${host}/v1/images/generations` mit `{ prompt, n, size, response_format }`, Antwort `{ data:[{ b64_json | url }] }`. **Wichtig:** Automatic1111/Forge (`/sdapi/v1/txt2img`) und ComfyUI (`/prompt`, Graph-basiert) sprechen dieses Protokoll **nicht** nativ — sie brauchen eine Bridge/einen Adapter davor.

### Variante A — LocalAI (empfohlener Drop-in)

[LocalAI](https://localai.io) exponiert `/v1/images/generations` nativ und rendert SD-/Flux-Modelle. Kein Adapter nötig. Fertiges Rezept für eine **NVIDIA RTX 3060 (8 GB)** inkl. `docker-compose.yml` (GPU, Single-Active-Backend, Idle-Watchdog) + Modell-YAMLs (SD 1.5 / SDXL low-VRAM) + Admin-Setup: **[image-host/](image-host/)**.

```yaml
# docker-compose.yml
services:
  localai:
    image: localai/localai:latest-aio-gpu-nvidia-cuda-12   # CPU: localai/localai:latest-aio-cpu
    ports:
      - "8080:8080"
    environment:
      - THREADS=8
    volumes:
      - ./models:/build/models
    # GPU (NVIDIA): deploy.resources.reservations.devices …
```

Modell einmalig laden (zieht ein SD-Image-Backend):

```bash
docker exec -it <container> local-ai models install stablediffusion
# oder ein konkretes Modell aus der Galerie, z. B. flux.1-dev / sd-3.5
```

Admin-Tab „Bilder":

| Feld | Wert |
|------|------|
| Bild-Generierung aktivieren | ✓ |
| Host | `http://localhost:8080` (bzw. interner Container-/LXC-Host) |
| Modell | `stablediffusion` (Name aus `local-ai models list`) |
| Bildgrösse | `1024x1024` |
| Timeout (ms) | `120000` |
| API-Key | leer (lokal) |

### Variante B — Automatic1111 / Forge via OpenAI-Adapter

A1111 selbst genügt **nicht**. Davor einen kleinen Adapter setzen, der `/v1/images/generations` auf `/sdapi/v1/txt2img` mappt (z. B. die Community-Projekte `SD-WebUI-OpenAI-API` / ein eigener FastAPI-Shim). Schema des Shims muss `{ data:[{ b64_json }] }` zurückgeben (A1111 liefert base64 im `images[]`-Array — 1:1 durchreichbar). Im Admin-Tab dann der **Adapter-Host** (nicht der A1111-Port).

### Variante C — ComfyUI via Bridge

ComfyUI ist Graph-basiert. Eine OpenAI-Bridge (Community-Node/Proxy, die einen txt2img-Workflow hinter `/v1/images/generations` kapselt) davorschalten und im Admin-Tab den **Bridge-Host** eintragen.

### Variante D — gehostete API

Echtes OpenAI o. Ä.: Host = `https://api.openai.com`, Modell z. B. `gpt-image-1`/`dall-e-3`, API-Key setzen. (Externer Datenfluss — bewusst wählen.)

### Verifizieren

Erst der Admin-Test-Button („Bild-Host prüfen", pingt `/v1/models`). Voller End-to-End-Check per curl:

```bash
curl -s http://localhost:8080/v1/images/generations \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"a lighthouse at dusk, oil painting","n":1,"size":"1024x1024","response_format":"b64_json"}' \
  | head -c 200
# erwartet: {"created":...,"data":[{"b64_json":"iVBORw0KGgo…
```

Danach im Buch-Chat (Provider Claude): „Zeichne mir ein Porträt von <Figur>". Das Modell ruft `generate_image` selbst auf, wenn der User ausdrücklich ein Bild wünscht.

## Pflicht-Invarianten

- **Nie in den Buchtext.** Das Bild ist Chat-Visualisierung; es gibt keinen Schreibpfad in Seiten/Manuskript.
- **Nur agentischer Buch-Chat** (`ai.provider=claude`, `jobs.book_chat.mode != classic`). Andere Provider haben keinen Tool-Loop → kein Bild.
- **Kein Bild im Tool-Result** — nur Metadaten (`image_id`/`mime`/`size`). Das BLOB lebt in `chat_images`, Auslieferung nur über `GET /chat/image/:id` mit Owner-Check.
- **Host/API-Key bleiben server-seitig** — `/config` liefert sie nie.
- **Abschaltbar** über `image.enabled=false` (Default) → Werkzeug nicht angeboten, Stream-Route bleibt (alte Bilder weiter abrufbar), Endpunkt nie gerufen.
- **Nur OpenAI-Image-Protokoll** (`/v1/images/generations`, `b64_json`/`url`). Native A1111-/ComfyUI-APIs brauchen einen Adapter.

## Tests

- Integration: [tests/integration/image-gen.test.js](../tests/integration/image-gen.test.js) (disabled→Wurf, kein Prompt→Wurf, b64_json→Buffer + Bearer/size/model-Forward, url-Fallback, Upstream-Fehler→`image_upstream`, leere Antwort→`image_empty`).
- Drift: `chat_images` in [erd.md](erd.md) + Squash gegated; Tool in [chat-tools.md](chat-tools.md).
