# Home Assistant Integration

Zwei Wege:

- **HACS-Integration** [schreibwerkstatt/homeassistant](https://github.com/schreibwerkstatt/homeassistant) (eigenes Repo, eigene Versionen) — liest `/metrics.json`, legt alle Entities aus den Beschreibungen selbst an, inklusive je ein Gerät pro Benutzer (Scope `metrics:users`). Einrichtung über die HA-Oberfläche, Reauth bei widerrufenem Token. Vertrag: [../metrics-api.md](../metrics-api.md#json-für-home-assistant).
- **Dieses YAML-Paket** — konsumiert `/metrics` als Prometheus-Text via Home Assistants `rest`-Integration, ohne Zusatzinstallation. Deckt die instanzweiten Kennzahlen ab, inklusive Lovelace-Dashboard mit Live-Tiles, Trends und Kosten-Tracking. Der Rest dieser Datei beschreibt diesen Weg.

## Voraussetzungen

- Schreibwerkstatt erreichbar von HA (HTTPS empfohlen, Self-signed funktioniert via `verify_ssl: false` im `rest:`-Block).
- API-Token mit Scope `metrics:read`. Anlegen im Admin-Tab **API / Metrics** ([Admin-Settings](../../public/partials/admin-settings.html)). Token-Klartext erscheint **einmalig** — direkt speichern.
- Home Assistant 2024.x oder neuer (`rest:`-Top-Level-Integration mit Multi-Sensor-Block).

## Installation

### 1. Token in `secrets.yaml`

```yaml
schreibwerkstatt_token: "Bearer sw_REPLACE_WITH_TOKEN"
schreibwerkstatt_url: "https://app.example.com/metrics"
```

### 2. Sensor-Config

Inhalt von [configuration.yaml](configuration.yaml) in die HA-`configuration.yaml` mergen. Enthält:

- **`rest:`-Block** mit einem HTTP-Call alle 60 s. Parst Prometheus-Text via `regex_findall` und befüllt die Sensoren in einem Rutsch.
- **`template:`-Block** für abgeleitete Werte (Minuten, Normseiten, Cache-Hit-Ratio).

> **Pflicht bei neuer Metric:** Jede neue `/metrics`-Kennzahl ([lib/metrics-collector.js](../../lib/metrics-collector.js)) braucht hier einen Eintrag — sonst erscheint sie nie in HA. Konkret: REST-Sensor in [configuration.yaml](configuration.yaml) (Pattern `((value | regex_findall('…')) + ['0']) | first | int(0)`), ggf. abgeleiteter `template:`-Sensor, eine Dashboard-Kachel in [dashboard.yaml](dashboard.yaml) und eine Zeile in der Sensor-Übersicht unten. Diese Doku-Pflicht ist auch in [metrics-api.md](../metrics-api.md) und [CLAUDE.md](../../CLAUDE.md) vermerkt.

Anschliessend HA neu starten (Settings → System → Restart).

### 3. Dashboard

Inhalt von [dashboard.yaml](dashboard.yaml) als neues Dashboard anlegen: Settings → Dashboards → **Add Dashboard** → **New dashboard from scratch** → drei Punkte oben rechts → **Raw configuration editor** → einfügen.

## Sensor-Übersicht

| Sensor | Quelle | Typ |
|---|---|---|
| `sensor.schreibwerkstatt_version` | `sw_build_info{version}` | String |
| `sensor.schreibwerkstatt_uptime` | `sw_process_uptime_seconds` | Duration |
| `sensor.schreibwerkstatt_memory_rss` / `_heap_used` | `sw_process_resident_memory_bytes` / `sw_process_heap_used_bytes` | Bytes |
| `sensor.schreibwerkstatt_db_size` / `_db_schema_version` | `sw_db_size_bytes` / `sw_db_schema_version` | Bytes / Zahl |
| `sensor.schreibwerkstatt_js_errors_24h` | `sw_js_errors_24h` | Count |
| `sensor.schreibwerkstatt_registrations_pending` | `sw_registration_requests_pending` | Count |
| `sensor.schreibwerkstatt_devices` | `sw_devices` (Sum) | Count |
| `sensor.schreibwerkstatt_users_active` / `_invited` / `_suspended` | `sw_users{status}` | Count |
| `sensor.schreibwerkstatt_active_users_24h` / `_7d` | `sw_active_users_24h/7d` | Count |
| `sensor.schreibwerkstatt_books` / `_pages` / `_chapters` | `sw_books/pages/chapters` | Count |
| `sensor.schreibwerkstatt_chars` / `_words` | `sw_chars/words` | Total |
| `sensor.schreibwerkstatt_normseiten` | Template (chars / 1800) | Total |
| `sensor.schreibwerkstatt_writing_seconds_today` / `_minutes` | `sw_writing_seconds_today` | Duration |
| `sensor.schreibwerkstatt_lektorat_seconds_today` / `_minutes` | `sw_lektorat_seconds_today` | Duration |
| `sensor.schreibwerkstatt_stt_seconds_today` / `_minutes` | `sw_stt_seconds_today` | Duration |
| `sensor.schreibwerkstatt_stt_chars_today` | `sw_stt_chars_today` | Count |
| `sensor.schreibwerkstatt_words_today` | `sw_words_today` (netto, kann negativ sein) | Count |
| `sensor.schreibwerkstatt_jobs_running` / `_queued` | `sw_jobs_running/queued` | Gauge |
| `sensor.schreibwerkstatt_jobs_in_memory` | `sw_jobs_in_memory` (Sum) | Gauge |
| `sensor.schreibwerkstatt_jobs_done_24h` / `_failed_24h` | `sw_jobs_ended_24h{status}` | Gauge |
| `sensor.schreibwerkstatt_jobs_finished_total` | `sw_jobs_finished_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_tokens_in_total` / `_out_total` | `sw_tokens_*_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_cache_read_tokens` / `_creation_tokens` | `sw_cache_*_tokens_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_cost_usd_total` | `sw_cost_usd_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_cost_usd_today` / `_month` | `sw_cost_usd_today` / `sw_cost_usd_month` | Total (Tag/Monat) |
| `sensor.schreibwerkstatt_cost_usd_by_type_total` | `sw_cost_usd_by_type_total` (Sum) | Total |
| `sensor.schreibwerkstatt_billed_usd_month` / `_billed_diff_usd_month` | `sw_billed_usd_month` / `sw_billed_diff_usd_month` (nur mit Anthropic-Admin-Key) | Total / Gauge |
| `sensor.schreibwerkstatt_cache_hit_ratio` | Template (cache_read / tokens_in) | Percent |
| `sensor.schreibwerkstatt_merge_silent_total` | `sw_merge_silent_total` | Counter |
| `sensor.schreibwerkstatt_merge_conflicts_shown_total` | `sw_merge_conflict_shown_total` | Counter |
| `sensor.schreibwerkstatt_merge_conflicts_resolved_total` | `sw_merge_conflict_resolved_total` (Sum) | Counter |
| `sensor.schreibwerkstatt_merge_fallback_overwrite_total` | `sw_merge_fallback_overwrite_total` | Counter |

## Dashboard-Layout

Eine View **Übersicht** mit folgenden Sektionen:

1. **Header** — Version + Active-User-Snapshot via Markdown.
2. **Heute schreiben** — Writing-, Lektorat- und Diktat-Minuten + diktierte Zeichen heute (Entity-Cards).
3. **Heute** — Netto-Wörter, Kosten heute / Monat, Anthropic-Abrechnung (Glance).
4. **Server** — Laufzeit, RAM, DB-Grösse, JS-Fehler 24h, offene Registrierungen (Glance).
5. **Betrieb** — Jobs ok/Fehler 24h, Jobs im RAM, Geräte, Heap, Schema-Version (Glance).
6. **Inhalte** — Bücher / Kapitel / Seiten / Zeichen / Normseiten (Glance, 5 Spalten).
7. **User** — Status-Aufschlüsselung + Aktivitäts-Fenster (Glance).
8. **Job-Queue (Live)** — Zwei Gauges mit Severity-Schwellen (grün / gelb / rot).
9. **KI-Kosten & Tokens** — Kumulierte USD, Input-/Output-Tokens, Cache-Hit, Kosten nach Typ, Abrechnungs-Abweichung (Glance).
10. **Block-Merge** — Auto-Merge / Banner / aufgelöste Blöcke / Overwrite-Fallback (Glance).
11. **Trends** — `history-graph`-Karten: Zeichen-Wachstum 7d, Job-Queue 24h, Schreib-/Lektorat-/Diktat-Minuten 24h, Kosten heute/Monat 7d, Kosten 30d.

## Werte pro Benutzer

Die `sw_user_*`-Kennzahlen (Schreibzeit, Tagesziel, Wörter, Kosten, zuletzt gesehen — Liste in [../metrics-api.md](../metrics-api.md#pro-user-scope-metricsusers)) liefert der Server nur an einen Token mit Scope `metrics:users` (Checkbox „Werte pro Benutzer" beim Ausstellen). Dieses YAML-Paket bildet sie **nicht** ab: die Label-Werte (welche User) sind nicht vorab bekannt, ein statischer `rest:`-Block müsste je User von Hand geklont werden. Die selbstbeschreibende Form dafür ist `GET /metrics.json` ([../metrics-api.md](../metrics-api.md#json-für-home-assistant)), aus der eine Integration Entities je User erzeugt.

## Per-Provider-/Model-Aufschlüsselung

Counter mit Labels (`sw_cost_usd_total{provider,model}`) werden in der Standard-Config zu einem Summen-Sensor zusammengefasst. Per-Kombi-Sensor:

```yaml
- name: Schreibwerkstatt Cost Claude Sonnet
  unique_id: sw_cost_claude_sonnet_4_6
  unit_of_measurement: USD
  value_template: >
    {{ value | regex_findall_index(
       'sw_cost_usd_total\{provider="claude",model="claude-sonnet-4-6"\}\s+([0-9.eE+-]+)',
       0) | float(0) | round(4) }}
  state_class: total_increasing
```

Für jede gewünschte `(provider, model)`-Kombi einen Sensor klonen. Provider/Model-Namen exakt aus dem Metrics-Output kopieren (Quote-Escape im Regex beachten).

## Alerting (optional)

Beispiel: Notification bei kumulierten Kosten > 50 USD:

```yaml
automation:
  - alias: Schreibwerkstatt Kosten-Alarm
    trigger:
      - platform: numeric_state
        entity_id: sensor.schreibwerkstatt_cost_usd_total
        above: 50
    action:
      - service: notify.mobile_app
        data:
          title: Schreibwerkstatt
          message: "KI-Kosten kumuliert über 50 USD."
```

Weitere sinnvolle Trigger:

- `sensor.schreibwerkstatt_jobs_queued` `above: 10` (Backlog-Alarm).
- `sensor.schreibwerkstatt_jobs_running` `above: 4` für `for: minutes: 10` (Worker-Stau).
- `sensor.schreibwerkstatt_cache_hit_ratio` `below: 20` (Prompt-Cache greift nicht mehr).

## Troubleshooting

- **`unavailable` auf allen Sensoren** — Token falsch oder abgelaufen. Check via `curl -H "Authorization: Bearer sw_…" https://app.example.com/metrics`. Status 401 → Token rotieren.
- **Sensor zeigt `unknown`** — Regex matcht nicht. Metric-Name aus `/metrics`-Output direkt prüfen (Backslash-Escape in `\{` / `\}` ist Pflicht in HA-YAML).
- **`IndexError: list index out of range`** beim ersten Render — `regex_findall_index` wirft, sobald Pattern nicht matcht (REST-Daten noch nicht da oder Metric fehlt im Output). Lösung ist bereits in [configuration.yaml](configuration.yaml) gepflegt: `((value | regex_findall('…')) + ['0']) | first | int(0)` statt `regex_findall_index`. Wer eigene Sensoren ergänzt, MUSS dasselbe Pattern verwenden.
- **Wert springt auf 0 nach Server-Restart** — Nur In-Memory-Gauges (`sw_jobs_running`, `sw_jobs_queued`). `*_total`-Counter persistieren in `job_runs`. Erwartetes Verhalten — siehe Pflicht-Invariante "Counter sind kumuliert seit DB-Init" in [metrics-api.md](../metrics-api.md).
- **History-Graph leer** — `state_class` muss gesetzt sein (in [configuration.yaml](configuration.yaml) bereits gepflegt). Recorder läuft sonst nicht auf den Sensor.

## Dateien

- [configuration.yaml](configuration.yaml) — Sensor-Block für HA.
- [dashboard.yaml](dashboard.yaml) — Lovelace-Dashboard.
