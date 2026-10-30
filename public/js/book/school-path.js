// Schullaufbahn der Figuren — reine Rechenschicht (Browser-ESM, SSoT).
//
// Beantwortet „in welcher Klasse war Figur X im Jahr Y" IM CODE, nicht im Modell.
// Ein Sprachmodell rechnet Stichtag, Schuljahreswechsel und Stufenuebertritte
// zuverlaessig falsch genug, dass eine Antwort im Chat nicht mehr belegt ist.
// Gleiche Haltung wie `get_figure_age` (routes/jobs/chat-tools/tools-timeline.js).
//
// Konsumenten: Bucheinstellungen (Vorlagen, Normalisierung), Figuren-Karte
// (Steckbrief + Lebenslauf-Zellen) und auf dem Server ueber lib/esm-bridge.js
// (`schoolPath()`): Schreibpfad der Bucheinstellung, Schulweg-Route, Job
// `schulweg-vorschlag` und das Buch-Chat-Werkzeug `get_figure_age`. Eine Rechnung,
// ueberall dieselbe Klasse.
//
// Keine Imports, keine DOM-/Alpine-Abhaengigkeit, keine UI-Strings: Labels sind
// i18n-Keys (`schule.*`), aufgeloest von den Konsumenten.
//
// Modell:
//   - Das BUCH hat ein Schulsystem (book_settings.schulsystem_json): Vorlage,
//     Einschulungsalter, Stichtag, Schuljahresbeginn, Jahre je Stufe, Standardweg.
//     Die Stufen und benannten Wege kommen aus der Vorlage; editierbar sind die
//     Jahre und der Standardweg.
//   - Die FIGUR hat optional einen Schulweg (figure_school_paths): Weg-Key,
//     Einschulungsjahr-Override, Repetitionen. Ohne Weg gilt der Standardweg.

// ── Vorlagen ────────────────────────────────────────────────────────────────
// `klasseStart`: Nummer der ersten Klasse der Stufe (Schweiz: jede Stufe ab 1,
// „1. Bez").
// `bis` am Weg: der Weg verlaesst eine Stufe nach dieser Klasse (Uebertritt vor
// deren Ende). Gedeckelt durch die eingestellten Jahre der Stufe.
//
// Ein Vorlage-, Stufen- oder Weg-Key ist eine PERSISTENZ-KONSTANTE (steht in
// book_settings.schulsystem_json und figure_school_paths.weg): ergaenzen ja,
// umbenennen nein.
export const SCHUL_VORLAGEN = Object.freeze({
  // Kanton Solothurn vor der Sek-I-Reform (bis Schuljahr 2010/11): Einschulung
  // mit 6 (Stichtag 30. April), Primar 6 Jahre, danach Oberstufe 3 Jahre (Bez /
  // Sek / Oberschule). Das Untergymnasium (3 Jahre) schloss an die 5. Primar an;
  // gute Bezirksschueler traten nach der 2. Bez in die Maturitaetsschule
  // (Obergymnasium, 4 Jahre) ueber — beide Wege fuehren nach 12 Schuljahren zur
  // Matur. Vor 1998/99 war das Langzeitgymnasium ab der 5. Primar ein Block von
  // 7 Jahren; gerechnet ergibt das dieselben Jahre.
  // Quellen: Solothurner Zeitung, «Das Untergymnasium ermöglichte eine besondere
  // Art der Begabtenförderung» und «Als die Bezirksschule noch die einzige
  // Alternative zur Oberschule war»; Wikipedia «Kantonsschule Solothurn».
  // `oberstufe` laesst den Schultyp (Bez / Sek / Oberschule) offen — fuer
  // Figuren, deren Schule der Text nicht nennt; daher auch der Standardweg.
  ch_so_1990: {
    einschulungsalter: 6,
    stichtag: { monat: 4, tag: 30 },
    schuljahrBeginn: 8,
    stufen: [
      { key: 'primar',   jahre: 6 },
      { key: 'bez',      jahre: 3 },
      { key: 'sek',      jahre: 3 },
      { key: 'ober',     jahre: 3 },
      { key: 'oberstufe', jahre: 3 },
      { key: 'untergym', jahre: 3 },
      { key: 'obergym',  jahre: 4 },
      { key: 'lehre',    jahre: 3 },
    ],
    wege: [
      { key: 'bez',         stufen: ['primar', 'bez'] },
      { key: 'bez_gym',     stufen: ['primar', 'bez', 'obergym'], bis: { bez: 2 } },
      { key: 'bez3_gym',    stufen: ['primar', 'bez', 'obergym'] },
      { key: 'bez_lehre',   stufen: ['primar', 'bez', 'lehre'] },
      { key: 'sek',         stufen: ['primar', 'sek'] },
      { key: 'sek_lehre',   stufen: ['primar', 'sek', 'lehre'] },
      { key: 'ober',        stufen: ['primar', 'ober'] },
      { key: 'ober_lehre',  stufen: ['primar', 'ober', 'lehre'] },
      { key: 'oberstufe',       stufen: ['primar', 'oberstufe'] },
      { key: 'oberstufe_lehre', stufen: ['primar', 'oberstufe', 'lehre'] },
      { key: 'kanti',       stufen: ['primar', 'untergym', 'obergym'], bis: { primar: 5 } },
      { key: 'kanti_lehre', stufen: ['primar', 'untergym', 'lehre'], bis: { primar: 5 } },
    ],
    standardWeg: 'oberstufe_lehre',
  },
  // HarmoS: elf Schuljahre ab vier (2 Kindergarten + 6 Primar + 3 Sek I),
  // Stichtag 31. Juli. Gymnasium hier vereinfacht nach der Sek I.
  ch_harmos: {
    einschulungsalter: 4,
    stichtag: { monat: 7, tag: 31 },
    schuljahrBeginn: 8,
    stufen: [
      { key: 'kiga',   jahre: 2 },
      { key: 'primar', jahre: 6 },
      { key: 'sek1',   jahre: 3 },
      { key: 'gym',    jahre: 3 },
      { key: 'lehre',  jahre: 3 },
    ],
    wege: [
      { key: 'sek',       stufen: ['kiga', 'primar', 'sek1'] },
      { key: 'sek_lehre', stufen: ['kiga', 'primar', 'sek1', 'lehre'] },
      { key: 'sek_gym',   stufen: ['kiga', 'primar', 'sek1', 'gym'] },
    ],
    standardWeg: 'sek',
  },
});

export const SCHUL_VORLAGE_KEYS = Object.freeze(Object.keys(SCHUL_VORLAGEN));

// Grenzen der editierbaren Zahlen — dieselben Werte stehen als numInput-Spec im
// Template (book-settings-school.html liest sie ueber `schulGrenzen()`).
export const SCHUL_GRENZEN = Object.freeze({
  einschulungsalter: { min: 3, max: 9 },
  stufeJahre: { min: 1, max: 10 },
  repetitionen: 4,
});

// ── i18n-Keys ───────────────────────────────────────────────────────────────
export const vorlageLabelKey = (k) => `schule.vorlage.${k}`;
export const stufeLabelKey   = (k) => `schule.stufe.${k}`;
export const klasseLabelKey  = (k) => `schule.klasse.${k}`;
export const wegLabelKey     = (k) => `schule.weg.${k}`;

const _int = (v) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : null;
};
const _clamp = (v, { min, max }) => Math.min(max, Math.max(min, v));

function _daysInMonth(monat, jahr = 2001) {
  return new Date(Date.UTC(jahr, monat, 0)).getUTCDate();
}

/** Gespeicherte Form eines Schulsystems normalisieren (Schreibpfad + Lesen).
 *  `null`/unbekannte Vorlage → null („kein Schulsystem"). Fremde Felder fallen
 *  weg, Zahlen werden geklemmt, ein unbekannter Standardweg faellt auf den der
 *  Vorlage zurueck. Akzeptiert auch einen JSON-String. */
export function normalizeSchulsystem(raw) {
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return null; }
  }
  if (!v || typeof v !== 'object') return null;
  const tpl = SCHUL_VORLAGEN[v.vorlage];
  if (!tpl) return null;

  const alter = _int(v.einschulungsalter);
  const stMonat = _int(v.stichtag?.monat);
  const stTag = _int(v.stichtag?.tag);
  const beginn = _int(v.schuljahr_beginn);
  const monatOk = stMonat != null && stMonat >= 1 && stMonat <= 12;
  const stichtag = monatOk
    ? { monat: stMonat, tag: stTag != null ? _clamp(stTag, { min: 1, max: _daysInMonth(stMonat) }) : _daysInMonth(stMonat) }
    : { ...tpl.stichtag };

  const jahre = {};
  for (const s of tpl.stufen) {
    const n = _int(v.jahre?.[s.key]);
    jahre[s.key] = n != null ? _clamp(n, SCHUL_GRENZEN.stufeJahre) : s.jahre;
  }
  const standard = tpl.wege.some(w => w.key === v.standard_weg) ? v.standard_weg : tpl.standardWeg;
  return {
    vorlage: v.vorlage,
    einschulungsalter: alter != null ? _clamp(alter, SCHUL_GRENZEN.einschulungsalter) : tpl.einschulungsalter,
    stichtag,
    schuljahr_beginn: beginn != null && beginn >= 1 && beginn <= 12 ? beginn : tpl.schuljahrBeginn,
    jahre,
    standard_weg: standard,
  };
}

/** Frisches Schulsystem aus einer Vorlage (Bucheinstellungen: Vorlage gewaehlt). */
export function schulsystemAusVorlage(vorlage) {
  return SCHUL_VORLAGEN[vorlage] ? normalizeSchulsystem({ vorlage }) : null;
}

/** Gespeicherte (normalisierte) Form → Rechenform mit Stufen und Wegen. */
export function resolveSchulsystem(stored) {
  const n = normalizeSchulsystem(stored);
  if (!n) return null;
  const tpl = SCHUL_VORLAGEN[n.vorlage];
  const stufen = {};
  for (const s of tpl.stufen) {
    stufen[s.key] = { key: s.key, jahre: n.jahre[s.key], klasseStart: s.klasseStart || 1 };
  }
  return {
    ...n,
    stufen,
    wege: tpl.wege.map(w => ({ key: w.key, stufen: [...w.stufen], bis: { ...(w.bis || {}) } })),
  };
}

/** Weg-Keys eines (gespeicherten oder aufgeloesten) Schulsystems. */
export function wegKeys(system) {
  const s = system?.wege ? system : resolveSchulsystem(system);
  return s ? s.wege.map(w => w.key) : [];
}

/** Repetitionen normalisieren: [{ stufe, klasse }], nur Stufen des Systems,
 *  Klasse innerhalb der Stufe, gedeckelt. Klasse = Nummer wie angezeigt
 *  (bei klasseStart 5 also 5..). */
export function normalizeRepetitionen(raw, system) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch { return []; }
  }
  if (!Array.isArray(list)) return [];
  const s = system?.stufen ? system : resolveSchulsystem(system);
  const out = [];
  for (const r of list) {
    const st = s?.stufen?.[r?.stufe];
    const k = _int(r?.klasse);
    if (!st || k == null) continue;
    if (k < st.klasseStart || k > st.klasseStart + st.jahre - 1) continue;
    out.push({ stufe: st.key, klasse: k });
    if (out.length >= SCHUL_GRENZEN.repetitionen) break;
  }
  return out;
}

/** Geburt aus einem Steckbrief-Text: „12.3.1985", „1985-03-12", „März 1985" wird
 *  nicht gelesen (nur Ziffernformen) — dann bleibt das Jahr allein. */
export function geburtAusText(text, jahr = null) {
  const s = String(text || '').trim();
  let m = s.match(/^(\d{1,2})\.\s?(\d{1,2})\.\s?(\d{4})$/);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = s.match(/\b(\d{4})\b/);
  if (m) return { y: +m[1] };
  return Number.isInteger(jahr) ? { y: jahr } : null;
}

/** Moegliche Einschulungsjahre bei Geburt { y, m?, d? }, in Reihenfolge der
 *  Wahrscheinlichkeit. Ein Kind wird im Jahr J eingeschult, wenn es bis zum
 *  Stichtag von J das Einschulungsalter erreicht. Ohne Monat (bzw. ohne Tag im
 *  Stichtag-Monat) ist nicht entscheidbar, ob der Geburtstag vor dem Stichtag
 *  liegt → zwei Jahre. */
export function einschulungsJahre(geburt, system) {
  const s = system?.stufen ? system : resolveSchulsystem(system);
  if (!s || !Number.isInteger(geburt?.y)) return [];
  const frueh = geburt.y + s.einschulungsalter;
  const spaet = frueh + 1;
  const { monat: sm, tag: sd } = s.stichtag;
  const m = Number.isInteger(geburt.m) ? geburt.m : null;
  const d = Number.isInteger(geburt.d) ? geburt.d : null;
  if (m != null) {
    if (m < sm) return [frueh];
    if (m > sm) return [spaet];
    if (d != null) return [d <= sd ? frueh : spaet];
    if (sd >= _daysInMonth(sm, geburt.y)) return [frueh];
  }
  // Wahrscheinlichere Variante zuerst: Anteil des Jahres nach dem Stichtag.
  const nachStichtag = (12 - sm) + (_daysInMonth(sm) - sd) / _daysInMonth(sm);
  return nachStichtag >= 6 ? [spaet, frueh] : [frueh, spaet];
}

/** Startjahr des Schuljahrs, in dem (jahr, monat) liegt. Ohne Monat: Herbst —
 *  das Schuljahr, das im Sommer dieses Jahres beginnt. */
export function schuljahrStart(jahr, monat, system) {
  const beginn = system?.schuljahr_beginn || 8;
  if (Number.isInteger(monat) && monat >= 1 && monat <= 12) return monat >= beginn ? jahr : jahr - 1;
  return jahr;
}

export const schuljahrLabel = (start) => `${start}/${start + 1}`;

/** Ablauf eines Wegs als Liste von Schuljahren: [{ stufe, klasse }] — eine
 *  Repetition wiederholt die Klasse (die Stufe dauert ein Jahr laenger); `bis`
 *  am Weg kuerzt eine Stufe (Uebertritt vor ihrem Ende). */
export function wegAblauf(system, wegKey, repetitionen = []) {
  const s = system?.stufen ? system : resolveSchulsystem(system);
  const weg = s?.wege.find(w => w.key === wegKey);
  if (!weg) return [];
  const reps = normalizeRepetitionen(repetitionen, s);
  const out = [];
  for (const key of weg.stufen) {
    const st = s.stufen[key];
    const jahre = Math.min(st.jahre, weg.bis?.[key] ?? st.jahre);
    for (let i = 0; i < jahre; i++) {
      const klasse = st.klasseStart + i;
      const n = 1 + reps.filter(r => r.stufe === key && r.klasse === klasse).length;
      for (let k = 0; k < n; k++) out.push({ stufe: key, klasse, ...(k > 0 ? { repetition: true } : {}) });
    }
  }
  return out;
}

/** Der wirksame Weg einer Figur: eigener Weg, sonst der Standardweg des Buchs. */
export function figurWeg(system, figur) {
  const keys = wegKeys(system);
  if (figur?.weg && keys.includes(figur.weg)) return figur.weg;
  const s = system?.stufen ? system : resolveSchulsystem(system);
  return s?.standard_weg || null;
}

function _position(ablauf, start, einschulung, weg) {
  const base = { schuljahr: schuljahrLabel(start), schuljahr_start: start, einschulung, weg };
  const idx = start - einschulung;
  if (idx < 0) return { ...base, status: 'vor_einschulung' };
  if (idx >= ablauf.length) {
    const letzte = ablauf[ablauf.length - 1];
    return { ...base, status: 'abgeschlossen', letzte_stufe: letzte?.stufe || null, abschluss_jahr: einschulung + ablauf.length };
  }
  const p = ablauf[idx];
  return { ...base, status: 'schule', stufe: p.stufe, klasse: p.klasse, ...(p.repetition ? { repetition: true } : {}) };
}

const _same = (a, b) => a.status === b.status && a.stufe === b.stufe && a.klasse === b.klasse;

/**
 * Wo stand die Figur im Schuljahr, in dem (jahr, monat) liegt?
 *
 * @param {object} p
 * @param {{y:number,m?:number,d?:number}} p.geburt
 * @param {object} p.system   gespeicherte oder aufgeloeste Form
 * @param {object} [p.figur]  { weg?, einschulung_jahr?, repetitionen? }
 * @param {number} p.jahr
 * @param {number} [p.monat]  ohne Monat: Herbst (Schuljahr ab Sommer `jahr`)
 * @returns {object|null}  { status: 'vor_einschulung'|'schule'|'abgeschlossen',
 *   stufe?, klasse?, schuljahr, schuljahr_start, einschulung, weg, unsicher?,
 *   alternative? } — null ohne System, Weg oder Geburtsjahr (und ohne Override).
 */
export function schoolStageAt({ geburt, system, figur = null, jahr, monat = null }) {
  const s = system?.stufen ? system : resolveSchulsystem(system);
  if (!s || !Number.isInteger(jahr)) return null;
  const weg = figurWeg(s, figur);
  if (!weg) return null;
  const override = _int(figur?.einschulung_jahr);
  const kandidaten = override != null ? [override] : einschulungsJahre(geburt, s);
  if (!kandidaten.length) return null;
  const ablauf = wegAblauf(s, weg, figur?.repetitionen || []);
  const start = schuljahrStart(jahr, monat, s);
  const [first, ...rest] = kandidaten.map(e => _position(ablauf, start, e, weg));
  const anders = rest.find(r => !_same(first, r));
  if (!anders) return first;
  // Geburtstag relativ zum Stichtag unbekannt: beide Varianten ausweisen statt
  // eine zu behaupten.
  const { schuljahr, schuljahr_start, weg: _w, ...alt } = anders;
  return { ...first, unsicher: true, alternative: alt };
}

/** Kalenderjahr ohne Monat: Fruehjahr und Herbst liegen in verschiedenen
 *  Schuljahren. Liefert { herbst, fruehjahr? } — `fruehjahr` nur, wenn es sich
 *  vom Herbst unterscheidet. */
export function schoolStagesForYear(args) {
  const herbst = schoolStageAt({ ...args, monat: null });
  if (!herbst) return null;
  const s = args.system?.stufen ? args.system : resolveSchulsystem(args.system);
  const fruehjahr = schoolStageAt({ ...args, monat: Math.max(1, (s?.schuljahr_beginn || 8) - 1) });
  return fruehjahr && !_same(herbst, fruehjahr) ? { herbst, fruehjahr } : { herbst };
}
