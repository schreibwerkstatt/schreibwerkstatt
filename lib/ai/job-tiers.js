'use strict';
// Modellstufen der Claude-Jobs: welche Stufen es gibt und welcher Job mit welcher
// Stufe startet. Reine Daten, ohne Abhängigkeit — die Settings-Registry
// (lib/app-settings/keys/ai.js) erzeugt daraus je Job einen Schlüssel
// `ai.claude.tier.job.<typ>`, die Auflösung liegt in routes/jobs/shared/model-tier.js,
// das Admin-UI («Provider → Claude → Modellstufen») rendert die Liste nach `group`.
//
// Stufen: `strong` ist das Instanz-Modell (`ai.claude.model` samt globalem Fenster,
// Output-Cap und Timeout). `max`, `standard` und `light` tragen je Modell, Fenster,
// Output-Cap und Timeout (`ai.claude.{model,context_window,max_tokens_out,timeout_ms}.tier.<stufe>`).
// `max` ist für die teuersten Urteile gedacht (z.B. Fable) und mit keinem Job vorbelegt.
//
// Ein Job, der hier fehlt, läuft stark. Neuer KI-Job ⇒ Zeile hier (Label über
// JOB_TYPE_LABELS bzw. `admin.settings.jobTier.job.<typ>`). Zwei Einträge sind keine
// Job-Typen, sondern Einzel-Calls innerhalb eines Jobs (Per-Call-Modell):
// `komplett-extract` (mechanische Extraktions-Calls der Komplettanalyse) und
// `chat-title` (Titel-Einzeiler eines Chats).

const TIERS = Object.freeze(['max', 'strong', 'standard', 'light']);

const JOB_TIER_GROUPS = Object.freeze(['lektorat', 'komplett', 'review', 'chats', 'werkstatt', 'katalog', 'recherche', 'werkzeuge']);

const JOB_TIER_CATALOG = Object.freeze([
  { type: 'check',                 group: 'lektorat',  tier: 'strong' },
  { type: 'batch-check',           group: 'lektorat',  tier: 'strong' },

  { type: 'komplett-analyse',      group: 'komplett',  tier: 'strong' },
  { type: 'komplett-extract',      group: 'komplett',  tier: 'strong' },
  { type: 'kontinuitaet',          group: 'komplett',  tier: 'strong' },
  { type: 'kontinuitaet-recheck',  group: 'komplett',  tier: 'strong' },
  { type: 'erzaehlprofil',         group: 'komplett',  tier: 'strong' },
  { type: 'faktencheck',           group: 'komplett',  tier: 'strong' },

  { type: 'review',                group: 'review',    tier: 'strong' },
  { type: 'chapter-review',        group: 'review',    tier: 'strong' },
  { type: 'stilprofil',            group: 'review',    tier: 'strong' },
  { type: 'autorenprofil',         group: 'review',    tier: 'strong' },
  { type: 'expose',                group: 'review',    tier: 'strong' },
  { type: 'headline-variants',     group: 'review',    tier: 'strong' },
  { type: 'struktur-check',        group: 'review',    tier: 'standard' },

  // Interaktiv, Wartezeit zählt; der User liest jede Antwort und übernimmt
  // Vorschläge einzeln. Stark, wo die Antwort am Text urteilt oder ins Werk
  // eingreift: der Abschnitts-Chat liefert Textersetzungen zur Lektoratskritik, der
  // Ideen-Chat setzt «erledigt» nur mit geprüftem Beleg, der Plot-Chat schlägt
  // Board-Änderungen vor, der Recherche-Chat pflegt das Archiv — im Replay echter
  // Prod-Chats übersah Sonnet dort Logikfehler, prüfte Ideen nicht am Text, las für den
  // Plot-Chat nicht nach und übersah bestehende Archiv-Einträge (keine Vorschläge).
  { type: 'chat',                  group: 'chats',     tier: 'strong' },
  { type: 'book-chat',             group: 'chats',     tier: 'standard' },
  { type: 'research-chat',         group: 'chats',     tier: 'strong' },
  { type: 'plot-chat',             group: 'chats',     tier: 'strong' },
  { type: 'ideen-chat',            group: 'chats',     tier: 'strong' },
  { type: 'chat-title',            group: 'chats',     tier: 'light' },

  { type: 'plot-brainstorm',       group: 'werkstatt', tier: 'strong' },
  { type: 'plot-consistency',      group: 'werkstatt', tier: 'strong' },
  { type: 'werkstatt-brainstorm',  group: 'werkstatt', tier: 'strong' },
  { type: 'werkstatt-consistency', group: 'werkstatt', tier: 'strong' },
  { type: 'motif-brainstorm',      group: 'werkstatt', tier: 'strong' },
  { type: 'motif-consistency',     group: 'werkstatt', tier: 'strong' },

  // Standard: Zusammenfassen, Herausziehen, Abgleichen über viele Abschnitte ohne
  // literarisches Urteil. Leicht: kurze mechanische Calls mit nachgelagerter Prüfung.
  { type: 'rueckblick',            group: 'katalog',   tier: 'standard' },
  { type: 'figur-alter',           group: 'katalog',   tier: 'standard' },
  { type: 'book-map-label',        group: 'katalog',   tier: 'standard' },
  { type: 'figuren-naehe',         group: 'katalog',   tier: 'light' },
  { type: 'stationen-vorschlag',   group: 'katalog',   tier: 'light' },
  { type: 'schulweg-vorschlag',    group: 'katalog',   tier: 'light' },
  { type: 'geocode-resolve',       group: 'katalog',   tier: 'light' },

  { type: 'research-crosscheck',   group: 'recherche', tier: 'standard' },
  { type: 'source-detect',         group: 'recherche', tier: 'standard' },
  { type: 'research-link',         group: 'recherche', tier: 'light' },
  { type: 'source-pdf-draft',      group: 'recherche', tier: 'light' },

  { type: 'synonym',               group: 'werkzeuge', tier: 'light' },
  { type: 'ideen-auto-check',      group: 'werkzeuge', tier: 'light' },
  { type: 'folder-import',         group: 'werkzeuge', tier: 'light' },
  { type: 'finetune-export',       group: 'werkzeuge', tier: 'light' },
]);

module.exports = { TIERS, JOB_TIER_GROUPS, JOB_TIER_CATALOG };
