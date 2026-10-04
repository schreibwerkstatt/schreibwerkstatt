'use strict';
// Metrik-Katalog: EINE Beschreibung je Kennzahl, aus der beide Formate
// entstehen — Prometheus-Text (/metrics, HELP/TYPE) und JSON fuer die
// Home-Assistant-Integration (/metrics.json, Einheit/Geraeteklasse/Zustandsklasse).
// Der Collector darf nur Namen emittieren, die hier stehen (wirft sonst).
//
// Felder:
//   type        'gauge' | 'counter'                     (Prometheus)
//   help        HELP-Zeile (deutsch, wie die Logs)
//   group       HA-Geraet: server | users | content | writing | jobs | ai | merge | user
//   unit        HA-Einheit ('s', 'B', 'USD', '%', …) oder null
//   deviceClass HA-Sensor-Geraeteklasse oder null
//   stateClass  'measurement' | 'total' | 'total_increasing' | null
//   reset       'day' | 'month' — Summe beginnt periodisch neu (HA: last_reset)
//   icon        mdi-Icon
//   diagnostic  true → HA entity_category diagnostic
//   disabled    true → in HA standardmaessig deaktiviert (viele Label-Kombis)
//   perUser     true → nur mit Scope `metrics:users`, Labels {user, user_name}
//   entity      false → kein HA-Sensor (Wert steckt in den Geraete-Infos)
//
// Anzeigename: i18n-Key `metrics.name.<name>` in de.json + en.json (Pflicht,
// gegated durch tests/unit/metrics-defs.test.js).

const G = (help, o = {}) => ({ type: 'gauge', help, ...o });
const C = (help, o = {}) => ({ type: 'counter', help, ...o });

const DUR_TODAY = { unit: 's', deviceClass: 'duration', stateClass: 'total_increasing', reset: 'day' };
const USD       = { unit: 'USD', deviceClass: 'monetary', stateClass: 'total' };
const BYTES     = { unit: 'B', deviceClass: 'data_size', stateClass: 'measurement' };
const COUNT     = { stateClass: 'measurement' };

const METRIC_DEFS = {
  // ── Server ────────────────────────────────────────────────────────────────
  sw_build_info: G('Build-/Versionsinfo (Wert immer 1)', { group: 'server', entity: false }),
  sw_process_uptime_seconds: G('Laufzeit des Server-Prozesses in Sekunden',
    { group: 'server', unit: 's', deviceClass: 'duration', stateClass: 'measurement', icon: 'mdi:timer-outline', diagnostic: true }),
  sw_process_resident_memory_bytes: G('Resident Set Size des Server-Prozesses',
    { group: 'server', ...BYTES, icon: 'mdi:memory', diagnostic: true }),
  sw_process_heap_used_bytes: G('Belegter V8-Heap des Server-Prozesses',
    { group: 'server', ...BYTES, icon: 'mdi:memory', diagnostic: true }),
  sw_db_size_bytes: G('Groesse der SQLite-Datenbank inkl. WAL',
    { group: 'server', ...BYTES, icon: 'mdi:database' }),
  sw_db_schema_version: G('Schema-Version der Datenbank',
    { group: 'server', icon: 'mdi:database-cog', diagnostic: true }),
  sw_js_errors_24h: G('Frontend-JS-Fehler der letzten 24h (js_errors)',
    { group: 'server', ...COUNT, icon: 'mdi:alert-circle-outline' }),
  sw_registration_requests_pending: G('Offene Registrierungsanfragen',
    { group: 'server', ...COUNT, icon: 'mdi:account-question' }),
  sw_devices: G('Aktive Device-Tokens nach Plattform und Client-Version',
    { group: 'server', ...COUNT, icon: 'mdi:cellphone-link', disabled: true }),

  // ── User ──────────────────────────────────────────────────────────────────
  sw_users: G('Anzahl User pro Status', { group: 'users', ...COUNT, icon: 'mdi:account-multiple' }),
  sw_active_users_24h: G('Aktive User (last_seen_at innerhalb 24h)',
    { group: 'users', ...COUNT, icon: 'mdi:account-clock' }),
  sw_active_users_7d: G('Aktive User (last_seen_at innerhalb 7 Tagen)',
    { group: 'users', ...COUNT, icon: 'mdi:account-clock-outline' }),

  // ── Inhalt ────────────────────────────────────────────────────────────────
  sw_books: G('Anzahl Buecher in der DB', { group: 'content', ...COUNT, icon: 'mdi:book-multiple' }),
  sw_pages: G('Anzahl Abschnitte in der DB', { group: 'content', ...COUNT, icon: 'mdi:file-document-multiple' }),
  sw_chapters: G('Anzahl Kapitel in der DB', { group: 'content', ...COUNT, icon: 'mdi:book-open-variant' }),
  sw_chars: G('Summe Zeichen ueber alle Abschnitte (page_stats.chars)',
    { group: 'content', ...COUNT, icon: 'mdi:format-letter-case' }),
  sw_words: G('Summe Woerter ueber alle Abschnitte (page_stats.words)',
    { group: 'content', ...COUNT, icon: 'mdi:text' }),
  sw_normseiten: G('Normseiten (1800 Zeichen je Normseite, abgeleitet aus sw_chars)',
    { group: 'content', ...COUNT, icon: 'mdi:file-document-outline' }),

  // ── Schreiben (heute, app.timezone) ───────────────────────────────────────
  sw_writing_seconds_today: G('Schreibsekunden heute (writing_time, app.timezone)',
    { group: 'writing', ...DUR_TODAY, icon: 'mdi:fountain-pen-tip' }),
  sw_lektorat_seconds_today: G('Lektorat-Sekunden heute (lektorat_time, app.timezone)',
    { group: 'writing', ...DUR_TODAY, icon: 'mdi:spellcheck' }),
  sw_stt_seconds_today: G('Diktat-Sekunden heute (stt_time, app.timezone)',
    { group: 'writing', ...DUR_TODAY, icon: 'mdi:microphone' }),
  sw_stt_chars_today: G('Diktierte Zeichen heute (stt_time, app.timezone)',
    { group: 'writing', stateClass: 'total_increasing', reset: 'day', icon: 'mdi:microphone-message' }),
  sw_words_today: G('Netto-Woerter heute: Stand minus letzter Tages-Snapshot (book_stats_history)',
    { group: 'writing', stateClass: 'measurement', reset: 'day', icon: 'mdi:text-box-plus' }),

  // ── Jobs ──────────────────────────────────────────────────────────────────
  sw_jobs_running: G('Aktuell laufende Jobs (in-memory state)', { group: 'jobs', ...COUNT, icon: 'mdi:cog-play' }),
  sw_jobs_queued: G('Wartende Jobs in der Queue', { group: 'jobs', ...COUNT, icon: 'mdi:tray-full' }),
  sw_jobs_in_memory: G('Jobs im In-Memory-State (vor Cleanup) nach Typ und Status',
    { group: 'jobs', ...COUNT, icon: 'mdi:cog', disabled: true }),
  sw_jobs_ended_24h: G('In den letzten 24h beendete Jobs nach Status (job_runs)',
    { group: 'jobs', ...COUNT, icon: 'mdi:cog-transfer' }),
  sw_jobs_finished_total: C('Beendete Jobs aus job_runs nach Typ und Status (kumuliert)',
    { group: 'jobs', stateClass: 'total_increasing', icon: 'mdi:cog-counterclockwise', disabled: true }),

  // ── KI: Tokens + Kosten (ai_cost_ledger) ──────────────────────────────────
  sw_tokens_in_total: C('Input-Tokens kumuliert pro Provider/Modell',
    { group: 'ai', stateClass: 'total_increasing', icon: 'mdi:import' }),
  sw_tokens_out_total: C('Output-Tokens kumuliert pro Provider/Modell',
    { group: 'ai', stateClass: 'total_increasing', icon: 'mdi:export' }),
  sw_cache_read_tokens_total: C('Cache-Read-Tokens kumuliert pro Provider/Modell',
    { group: 'ai', stateClass: 'total_increasing', icon: 'mdi:cached', disabled: true }),
  sw_cache_creation_tokens_total: C('Cache-Write-Tokens kumuliert pro Provider/Modell',
    { group: 'ai', stateClass: 'total_increasing', icon: 'mdi:cached', disabled: true }),
  sw_cost_usd_total: C('Kumulierte API-Kosten in USD pro Provider/Modell (eingefroren im Kosten-Ledger)',
    { group: 'ai', ...USD, icon: 'mdi:cash' }),
  sw_cost_usd_today: G('API-Kosten heute in USD (app.timezone)',
    { group: 'ai', ...USD, reset: 'day', icon: 'mdi:cash-clock' }),
  sw_cost_usd_month: G('API-Kosten im laufenden Monat in USD (app.timezone)',
    { group: 'ai', ...USD, reset: 'month', icon: 'mdi:cash-multiple' }),
  sw_cost_usd_by_type_total: C('Kumulierte API-Kosten in USD nach Quelle und Job-Typ',
    { group: 'ai', ...USD, icon: 'mdi:cash', disabled: true }),
  sw_billed_usd_month: G('Von Anthropic abgerechnete Kosten im laufenden UTC-Monat (Cost-Report)',
    { group: 'ai', ...USD, reset: 'month', icon: 'mdi:receipt-text' }),
  sw_billed_diff_usd_month: G('Abrechnung minus App-Ledger im laufenden UTC-Monat (abgerechnete Tage)',
    // Kein deviceClass 'monetary': HA erlaubt dort nur state_class total, eine Differenz ist keine Summe.
    { group: 'ai', unit: 'USD', stateClass: 'measurement', icon: 'mdi:scale-unbalanced', diagnostic: true }),

  // ── Block-Merge-Telemetrie ────────────────────────────────────────────────
  sw_merge_silent_total: C('Stille Block-Auto-Merges ohne User-Aktion (kumuliert)',
    { group: 'merge', stateClass: 'total_increasing', icon: 'mdi:call-merge', diagnostic: true }),
  sw_merge_conflict_shown_total: C('Konflikt-Auflösungs-Banner angezeigt (kumuliert)',
    { group: 'merge', stateClass: 'total_increasing', icon: 'mdi:source-branch', diagnostic: true }),
  sw_merge_fallback_overwrite_total: C('Klassischer Last-Write-Wins-Overwrite trotz aktivem Block-Merge (kumuliert)',
    { group: 'merge', stateClass: 'total_increasing', icon: 'mdi:content-save-alert', diagnostic: true }),
  sw_merge_conflict_resolved_total: C('Aufgelöste Konflikt-Blöcke nach gewählter Seite (kumuliert)',
    { group: 'merge', stateClass: 'total_increasing', icon: 'mdi:source-merge', diagnostic: true }),

  // ── Pro User (Scope metrics:users) ────────────────────────────────────────
  sw_user_writing_seconds_today: G('Schreibsekunden heute je User',
    { group: 'user', perUser: true, ...DUR_TODAY, icon: 'mdi:fountain-pen-tip' }),
  sw_user_lektorat_seconds_today: G('Lektorat-Sekunden heute je User',
    { group: 'user', perUser: true, ...DUR_TODAY, icon: 'mdi:spellcheck' }),
  sw_user_stt_seconds_today: G('Diktat-Sekunden heute je User',
    { group: 'user', perUser: true, ...DUR_TODAY, icon: 'mdi:microphone' }),
  sw_user_daily_goal_percent: G('Erreichter Anteil des Tagesziels (Schreibminuten) je User',
    { group: 'user', perUser: true, unit: '%', stateClass: 'measurement', icon: 'mdi:target' }),
  sw_user_words_today: G('Netto-Woerter heute in eigenen Buechern je User',
    { group: 'user', perUser: true, stateClass: 'measurement', reset: 'day', icon: 'mdi:text-box-plus' }),
  sw_user_books: G('Eigene Buecher je User', { group: 'user', perUser: true, ...COUNT, icon: 'mdi:book-multiple' }),
  sw_user_words: G('Woerter in eigenen Buechern je User', { group: 'user', perUser: true, ...COUNT, icon: 'mdi:text' }),
  sw_user_cost_usd_today: G('API-Kosten heute je User',
    { group: 'user', perUser: true, ...USD, reset: 'day', icon: 'mdi:cash-clock' }),
  sw_user_cost_usd_month: G('API-Kosten im laufenden Monat je User',
    { group: 'user', perUser: true, ...USD, reset: 'month', icon: 'mdi:cash-multiple' }),
  sw_user_cost_usd_total: C('Kumulierte API-Kosten je User',
    { group: 'user', perUser: true, ...USD, icon: 'mdi:cash' }),
  sw_user_last_seen_timestamp_seconds: G('Zuletzt gesehen je User (Unix-Sekunden)',
    { group: 'user', perUser: true, unit: 's', deviceClass: 'timestamp', icon: 'mdi:account-clock' }),
};

module.exports = { METRIC_DEFS };
