'use strict';
/**
 * Lauf-Umfang der Komplettanalyse — SSoT des Schritt-Katalogs.
 *
 * Der Katalog beantwortet EINE Frage: welche Schritte eines Laufs darf der User
 * abwählen? Kriterium ist nicht „technisch überspringbar", sondern: spart das
 * Abwählen einen KI-Call oder schützt es einen kuratierbaren Katalog vor dem
 * Full-Replace. Was beides verneint, gehört in den Kern und steht im Modal als
 * ausgegraute Zeile — die Liste ist damit zugleich ein ehrliches Inventar dessen,
 * was der Job überhaupt tut.
 *
 * Die EXTRAKTION ist bewusst NICHT gated: sie ist ein Lesevorgang über das ganze
 * Buch und lässt sich nicht „nur für Songs" billiger machen; ein Teil-Extrakt im
 * Delta-Cache wäre ausserdem eine halbe Wahrheit, die jeder Folgelauf als
 * vollständig läse (dasselbe Muster, gegen das `faktenFailed` schon schützt).
 * Die Ersparnis eines Teil-Laufs kommt aus Konsolidierung und Urteil — und genau
 * die sind bei einem Wiederholungslauf (Cache-HIT der Extraktion) die Gesamtkosten.
 *
 * Frontend-Spiegel: public/js/komplett-scope.js (Drift gegated durch
 * tests/unit/komplett-scope.test.mjs).
 */

// Abwählbare Schritte, in Anzeige-Reihenfolge. `group` gruppiert im Modal,
// `cloudOnly` blendet den Schritt für die lokale Provider-Klasse aus (dieselbe
// Entscheidung wie `/config` komplett.continuity und das Überspringen im Job).
const KOMPLETT_STEPS = [
  { key: 'orte',          group: 'katalog',  cloudOnly: false },
  { key: 'szenen',        group: 'katalog',  cloudOnly: false },
  { key: 'ereignisse',    group: 'katalog',  cloudOnly: false },
  { key: 'beziehungen',   group: 'katalog',  cloudOnly: false },
  { key: 'songs',         group: 'katalog',  cloudOnly: false },
  { key: 'kontinuitaet',  group: 'pruefung', cloudOnly: true  },
  { key: 'erzaehlprofil', group: 'pruefung', cloudOnly: true  },
  { key: 'coverage',      group: 'pruefung', cloudOnly: true  },
];

// Kern: läuft immer. Reine Anzeige-Liste fürs Modal — kein Schalter, kein Flag.
// `figuren` trägt die Identität (figNameToId), an der jeder Folgeschritt hängt;
// `weltfakten` ist ein abgeleiteter, nicht kuratierter Index, dessen Schreiben
// keinen Call kostet (die Fakten liegen nach der Extraktion ohnehin vor).
const KOMPLETT_CORE_STEPS = ['seiten', 'extraktion', 'figuren', 'weltfakten'];

const KOMPLETT_STEP_KEYS = KOMPLETT_STEPS.map(s => s.key);

/**
 * Rohen Umfang (Request-Body oder DB-Zeile) auf genau die bekannten Schlüssel
 * normalisieren. Unbekanntes fällt weg, Fehlendes ist AN.
 *
 * Fehlend = an ist Absicht in beide Richtungen: ein Aufrufer ohne `scope` bekommt
 * den vollständigen Lauf (unverändertes Verhalten, Nacht-Cron inklusive), und ein
 * gespeicherter Umfang von vor einem neuen Schritt lässt diesen laufen, statt ihn
 * still nie wieder auszuführen.
 */
function normalizeKomplettScope(raw) {
  const src = (raw && typeof raw === 'object') ? raw : {};
  const out = {};
  for (const key of KOMPLETT_STEP_KEYS) out[key] = src[key] !== false;
  return out;
}

/** Läuft alles? Nur dann darf der Konsolidierungs-Checkpoint geschrieben werden. */
function isFullKomplettScope(scope) {
  const s = normalizeKomplettScope(scope);
  return KOMPLETT_STEP_KEYS.every(k => s[k] === true);
}

/** Abgewählte Schritte — für Log-Zeile und Job-Result. */
function skippedKomplettSteps(scope) {
  const s = normalizeKomplettScope(scope);
  return KOMPLETT_STEP_KEYS.filter(k => s[k] === false);
}

/**
 * Phasen der Fortschrittsanzeige im Status-Panel. `end` ist der Progress-Wert, den
 * der Job beim Abschluss der Phase meldet — der Job setzt ihn über `PHASE_END`, das
 * Panel hakt die Phase daran ab. Ein Ort für beide Seiten: verschiebt sich eine
 * Grenze nur im Job, hakt das Panel zu früh oder zu spät ab, ohne dass es auffällt.
 * `scope`: abwählbare Schritte, an denen die Phase hängt (alle abgewählt → Zeile
 * fällt weg). `onlyMulti`: läuft nur im Multi-Pass (Kapitel einzeln extrahiert).
 */
const KOMPLETT_PHASES = [
  { key: 'loadPages',          end: 12 },
  { key: 'extract',            end: 30 },
  { key: 'figurenConsolidate', end: 43 },
  { key: 'orteConsolidate',    end: 55, scope: ['orte'] },
  { key: 'songsConsolidate',   end: 56, scope: ['songs'] },
  { key: 'chapterRelations',   end: 58, scope: ['beziehungen'], onlyMulti: true },
  { key: 'szenenEvents',       end: 78, scope: ['szenen', 'ereignisse'] },
  { key: 'timeline',           end: 97, scope: ['ereignisse'] },
];

const PHASE_END = Object.fromEntries(KOMPLETT_PHASES.map(p => [p.key, p.end]));

module.exports = {
  KOMPLETT_PHASES,
  PHASE_END,
  KOMPLETT_STEPS,
  KOMPLETT_STEP_KEYS,
  KOMPLETT_CORE_STEPS,
  normalizeKomplettScope,
  isFullKomplettScope,
  skippedKomplettSteps,
};
