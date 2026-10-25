// Exposé: Inhaltsangaben je Kapitel (Multi-Pass) + das Exposé selbst
// (Logline, Kurzinhalt, Synopse, Figurenliste, Klappentext-Vorschlag bzw. die
// Sachbuch-Variante). Job: routes/jobs/expose.js, Doku: docs/expose.md.
//
// Die Eckdaten (Titel, Autor, Genre, Umfang, Zielgruppe, Vergleichstitel …)
// kommen als FAKTEN des Autors in den Prompt und werden nicht zurückgegeben —
// sie leben in book_settings/book_publication und werden dort gepflegt.
//
// Cache: die Signaturen im Job hashen die GESENDETEN Prompts. Diese Datei
// fliesst darum bewusst NICHT in `_promptsContentHash` (eine Wortlaut-Änderung
// hier soll nicht jeden anderen persistenten Cache verwerfen).

import { _obj, _str, _num } from './schema-utils.js';
import { JSON_ONLY, _jsonOnly } from './state.js';
import { reviewProfil } from './review-typen.js';

// Exposé-Profil aus dem Buchtyp. Erzählende Werke → Roman-Exposé, Sach-/Fach-
// bücher → Sachbuch-Exposé; für Lyrik, Tagebuch und Journalismus gibt es kein
// Exposé (null) — der Reiter blendet sich dort aus.
export function exposeProfil(buchtyp) {
  const p = reviewProfil(buchtyp);
  if (p === 'narrativ') return 'narrativ';
  if (p === 'sachlich' || p === 'wissenschaft') return 'sachlich';
  return null;
}

// Buchtypen ohne Exposé als Liste — für Palette/Hilfe (`hiddenForBuchtyp`) und
// den serverseitigen Precheck. Muss deckungsgleich mit exposeProfil() → null
// sein; gegated durch tests/unit/expose-prompt.test.mjs.
export const EXPOSE_HIDDEN_BUCHTYPEN = ['lyrik', 'tagebuch', 'journalismus'];

const PERSONA = 'Du bist eine erfahrene Literaturagentin. Du schreibst Exposés, Synopsen und Klappentexte für Manuskripte, die Verlagen und Agenturen angeboten werden: präzise, klar, verkaufend, ohne Floskeln und ohne Superlative. Du arbeitest ausschliesslich mit dem, was das Manuskript und die Angaben des Autors hergeben – du erfindest keine Handlung, keine Figur, keine Wendung und keine Vergleichstitel. Du schreibst in der Sprache des Buchs und hältst die unten genannte Sprachnorm ein.';

/** System-Prompt: Persona + Sprachnorm/Buch-Kontext (getResearchPromptContext). */
export function buildExposeSystem(bookContext = '') {
  return [PERSONA, (bookContext || '').trim(), JSON_ONLY].filter(Boolean).join('\n\n');
}

// ── Inhaltsangabe je Kapitel (Multi-Pass) ──────────────────────────────────────
const SYNOPSIS_TASK = {
  narrativ: 'Fasse den Abschnitt als nüchterne Inhaltsangabe zusammen: was geschieht, wer handelt, wo und wann, welche Wendungen es gibt und wie der Abschnitt endet (der Stand am Ende ist wichtig). 5–10 Sätze, Präsens, dritte Person.',
  sachlich: 'Fasse den Abschnitt als nüchterne Inhaltsangabe zusammen: welche Fragen er stellt, welche Inhalte, Thesen und Belege er bringt und zu welchem Ergebnis er kommt. 4–8 Sätze, Präsens.',
};

/**
 * @param {{ bookName:string, kapitel:string, teil?:{nr:number, von:number}|null, profil:'narrativ'|'sachlich', text:string }} a
 */
export function buildExposeSynopsisPrompt({ bookName, kapitel, teil = null, profil, text }) {
  const teilLabel = teil ? ` (Teil ${teil.nr} von ${teil.von})` : '';
  return `<aufgabe>
${SYNOPSIS_TASK[profil] || SYNOPSIS_TASK.narrativ}
Keine Wertung, keine Zitate, nichts, was nicht im Text steht. Die Inhaltsangabe dient später als
Grundlage eines Exposés für das ganze Buch «${bookName}».
</aufgabe>
<abschnitt kapitel="${kapitel}${teilLabel}">
${text}
</abschnitt>
<ausgabe>{ "inhalt": "Inhaltsangabe als Fliesstext" }</ausgabe>${_jsonOnly()}`;
}

export const SCHEMA_EXPOSE_SYNOPSIS = _obj({ inhalt: _str });

// ── Exposé ─────────────────────────────────────────────────────────────────────
function _eckdatenBlock(e) {
  const lines = [];
  const add = (label, v) => { const s = String(v ?? '').trim(); if (s) lines.push(`${label}: ${s}`); };
  add('Titel', e.titel);
  add('Untertitel', e.untertitel);
  add('Autor', e.autor);
  add('Genre/Buchtyp', e.genre);
  add('Erzählperspektive', e.erzaehlperspektive);
  add('Erzählzeit', e.erzaehlzeit);
  if (e.normseiten) lines.push(`Umfang: ca. ${e.normseiten} Normseiten`);
  add('Zielgruppe (Angabe des Autors)', e.zielgruppe);
  add('Vergleichstitel (Angabe des Autors)', e.vergleichstitel);
  if (e.unfertig) lines.push('Stand: Das Manuskript ist noch nicht abgeschlossen. Beschreibe nur, was geschrieben ist; erfinde kein Ende.');
  return `<eckdaten>
Fakten des Autors. Übernimm sie nicht in die Ausgabe und ändere sie nicht; nutze sie als Rahmen.
${lines.join('\n')}
</eckdaten>`;
}

function _figurenBlock(figuren) {
  if (!figuren?.length) return '';
  const rows = figuren.map(f => {
    const parts = [f.typ, f.rolle, f.motivation && `Motivation: ${f.motivation}`, f.konflikt && `Konflikt: ${f.konflikt}`, f.entwicklung && `Entwicklung: ${f.entwicklung}`]
      .filter(Boolean).join(' · ');
    return `[id=${f.id}] ${f.name}${parts ? ` — ${parts}` : ''}`;
  });
  return `\n<figurenkatalog>
Figuren aus der Analyse des Buchs. In der Figurenliste NUR diese IDs verwenden.
${rows.join('\n')}
</figurenkatalog>`;
}

function _kapitelBlock(kapitel) {
  if (!kapitel?.length) return '';
  return `\n<kapitel>
Kapitel in Lesereihenfolge. In der Gliederung NUR diese IDs verwenden, je Kapitel genau ein Eintrag.
${kapitel.map(k => `[id=${k.id}] ${k.name}`).join('\n')}
</kapitel>`;
}

function _quelleBlock(quelle) {
  if (quelle.kind === 'volltext') {
    return `\n<manuskript>
${quelle.text}
</manuskript>`;
  }
  return `\n<inhaltsangaben>
Das Manuskript ist zu lang für einen Durchgang. Grundlage sind Inhaltsangaben je Kapitel in
Lesereihenfolge; nutze nur, was dort steht.
${quelle.items.map(i => `## ${i.kapitel}\n${i.inhalt}`).join('\n\n')}
</inhaltsangaben>`;
}

const OUTPUT = {
  narrativ: `<ausgabe>
{
  "logline": "Ein Satz, höchstens 35 Wörter: Hauptfigur, ihr Ziel, was auf dem Spiel steht, der zentrale Konflikt.",
  "kurzinhalt": "Höchstens 90 Wörter (eine Drittelseite): Hauptfigur, Ausgangslage, Konflikt, Zeit und Ort. Ohne Cliffhanger-Fragen.",
  "synopse": "Die ganze Handlung in Präsens und dritter Person, 1–2 Normseiten (1800–3600 Zeichen), in Absätzen. MIT Ende und Auflösung – eine Agentur will wissen, wie das Buch ausgeht.",
  "figuren": [ { "fig_id": "ID aus dem Figurenkatalog", "text": "2–3 Sätze: Rolle in der Handlung, Ziel, Konflikt, Entwicklung." } ],
  "klappentext": "120–180 Wörter für Leserinnen und Leser: Sog, Figur, Frage. OHNE das Ende zu verraten."
}
Figurenliste: höchstens 8 Figuren, nur solche, die die Handlung vorantreiben, wichtigste zuerst.
</ausgabe>`,
  sachlich: `<ausgabe>
{
  "logline": "Ein Satz, höchstens 35 Wörter: worum es geht und was das Buch dem Leser gibt.",
  "kurzbeschreibung": "Höchstens 120 Wörter: Thema, Fragestellung, Ansatz, Ergebnis.",
  "alleinstellung": "Höchstens 100 Wörter: was dieses Buch von anderen zum Thema unterscheidet – nur, was das Manuskript belegt.",
  "gliederung": [ { "chapter_id": 0, "text": "Ein Satz zum Inhalt des Kapitels." } ],
  "klappentext": "120–180 Wörter für Leserinnen und Leser: Problem, Versprechen, Nutzen."
}
</ausgabe>`,
};

/**
 * @param {object} a
 * @param {'narrativ'|'sachlich'} a.profil
 * @param {object} a.eckdaten   { titel, untertitel, autor, genre, erzaehlperspektive, erzaehlzeit, normseiten, zielgruppe, vergleichstitel, unfertig }
 * @param {Array}  a.figuren    [{ id, name, typ, rolle, motivation, konflikt, entwicklung }] (narrativ)
 * @param {Array}  a.kapitel    [{ id, name }] (sachlich)
 * @param {object} a.quelle     { kind:'volltext', text } | { kind:'inhaltsangaben', items:[{ kapitel, inhalt }] }
 */
export function buildExposePrompt({ profil, eckdaten, figuren = [], kapitel = [], quelle }) {
  const was = profil === 'sachlich'
    ? 'ein Sachbuch-Exposé (Logline, Kurzbeschreibung, Alleinstellung, Gliederung) und einen Klappentext-Vorschlag'
    : 'ein Roman-Exposé (Logline, Kurzinhalt, Synopse, Figurenliste) und einen Klappentext-Vorschlag';
  return `<aufgabe>
Schreibe für das Manuskript ${was}. Grundlage ist ausschliesslich das Manuskript bzw. die
Inhaltsangaben unten; die Eckdaten sind der Rahmen.
</aufgabe>
${_eckdatenBlock(eckdaten)}${profil === 'sachlich' ? _kapitelBlock(kapitel) : _figurenBlock(figuren)}${_quelleBlock(quelle)}
${OUTPUT[profil] || OUTPUT.narrativ}${_jsonOnly()}`;
}

const _figurItem = _obj({ fig_id: _str, text: _str });
const _gliederungItem = _obj({ chapter_id: _num, text: _str });

/** Schema + Pflicht-Textfelder je Profil (der Job prüft die Felder nach dem Call). */
export const EXPOSE_FIELDS = {
  narrativ: { text: ['logline', 'kurzinhalt', 'synopse', 'klappentext'], list: 'figuren' },
  sachlich: { text: ['logline', 'kurzbeschreibung', 'alleinstellung', 'klappentext'], list: 'gliederung' },
};

export function buildExposeSchema(profil) {
  if (profil === 'sachlich') {
    return _obj({ logline: _str, kurzbeschreibung: _str, alleinstellung: _str,
      gliederung: { type: 'array', items: _gliederungItem }, klappentext: _str });
  }
  return _obj({ logline: _str, kurzinhalt: _str, synopse: _str,
    figuren: { type: 'array', items: _figurItem }, klappentext: _str });
}
