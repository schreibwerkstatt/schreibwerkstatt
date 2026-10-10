// Prompt-Contract-Test für das Lektorat: verankert die kritischen Invarianten-
// Instruktionen im gebauten Prompt, damit ein Refactor sie nicht STILL entfernt.
//
// Dies ist kein Output-Qualitäts-Eval (das läuft manuell gegen die echte KI via
// `npm run eval:lektorat`), sondern ein Drift-Schutz auf Prompt-STRUKTUR-Ebene:
// jeder Block, der empirisch messbaren Effekt hat (Korrektur-Purität, Zeichen-
// genauigkeit, Anti-Doppelung, Schwere-Schwelle, Selbstkontroll-Pass, das
// VERWORFENE Few-Shot-Beispiel, die XML-Sektionierung), muss im Cloud-Prompt
// vorhanden bleiben. Der lokale Prompt lässt bewusst einen Teil weg – auch das
// wird gegengeprüft, damit die _isLocal-Reduktion nicht versehentlich kippt.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'prompt-config.json'), 'utf8'));
const prompts = await import(pathToFileURL(path.join(ROOT, 'public', 'js', 'prompts.js')).href);

const SAMPLE = 'Es war ein warmer Tag. Sie ging zum Fluss.';

function buildCloud() {
  prompts.configurePrompts(cfg, 'claude');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' });
}
function buildLocal() {
  prompts.configurePrompts(cfg, 'ollama');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' });
}

// Cloud-Prompt: alle wirkungsstarken Blöcke müssen vorhanden sein.
const CLOUD_INVARIANTS = [
  ['XML-Aufgabe',            '<aufgabe>'],
  ['Output-Format',          '<output_format>'],
  ['Originaltext-Wrapper',   '<originaltext'],
  ['Korrektur-Purität',      'KORREKTUR-PURITÄT'],
  ['Zeichengenauigkeit',     'ZEICHENGENAUIGKEIT von «original»'],
  ['Span-Typ-Konsistenz',    'SPAN-TYP-KONSISTENZ'],
  ['Anti-Doppelung',         'EIN-EINTRAG-PRO-STELLE'],
  ['Schwere-Schwelle',       'SCHWERE-SCHWELLE'],
  ['Selbstkontroll-Pass',    'SELBSTKONTROLL-PASS'],
  ['Verworfenes Few-Shot',   'Beispiel eines VERWORFENEN Eintrags'],
  ['Gutes Few-Shot',         'Beispiel eines GUTEN Eintrags'],
  ['Zusammenfassungs-Disjunktion', 'ZUSAMMENFASSUNGS-DISJUNKTION'],
  ['Mechanik-Ausnahme (nie streichen)', 'MECHANISCHE FEHLER'],
];

test('Cloud-Lektorat-Prompt enthält alle Invarianten-Blöcke', () => {
  const p = buildCloud();
  for (const [label, needle] of CLOUD_INVARIANTS) {
    assert.ok(p.includes(needle), `Cloud-Prompt fehlt Block: ${label} («${needle}»)`);
  }
});

test('Cloud-Lektorat-Prompt liefert das volle Typ-Enum + szenen/stilanalyse/fazit', () => {
  const p = buildCloud();
  for (const typ of ['show_vs_tell', 'ki_geruch', 'perspektivbruch', 'tempuswechsel', 'dialogformat', 'namenskonsistenz']) {
    assert.ok(p.includes(typ), `Cloud-Prompt fehlt Typ: ${typ}`);
  }
  assert.ok(p.includes('"szenen"'), 'Cloud-Schema muss szenen enthalten');
  assert.ok(p.includes('"stilanalyse"'), 'Cloud-Schema muss stilanalyse enthalten');
  assert.ok(p.includes('"fazit"'), 'Cloud-Schema muss fazit enthalten');
});

test('Lokaler Lektorat-Prompt ist bewusst reduziert (kein Schwere-/Selbstkontroll-Block, keine szenen)', () => {
  const local = buildLocal();
  assert.ok(!local.includes('SCHWERE-SCHWELLE'), 'Lokal: keine Schwere-Schwelle');
  assert.ok(!local.includes('SELBSTKONTROLL-PASS'), 'Lokal: kein Selbstkontroll-Pass');
  assert.ok(!local.includes('"szenen"'), 'Lokal: kein szenen-Schema');
  // Der spezialisierte Show-vs-Tell-REGELBLOCK ist cloud-only (der bloße Token
  // «show_vs_tell» taucht lokal noch im Anti-Doppelungs-Beispiel auf – daher am
  // Blockheader prüfen, nicht am Token).
  assert.ok(!local.includes('Show-vs-Tell-Regeln'), 'Lokal: kein Show-vs-Tell-Regelblock');
  assert.ok(!local.includes('KI-Geruch-Regeln'), 'Lokal: kein KI-Geruch-Regelblock');
  // ...aber die Kern-Puritäts-Invarianten bleiben auch lokal:
  assert.ok(local.includes('KORREKTUR-PURITÄT'), 'Lokal: Korrektur-Purität muss bleiben');
  assert.ok(local.includes('ZEICHENGENAUIGKEIT von «original»'), 'Lokal: Zeichengenauigkeit muss bleiben');
  assert.ok(local.includes('EIN-EINTRAG-PRO-STELLE'), 'Lokal: Anti-Doppelung muss bleiben');
  // Reconfigure zurück auf Cloud, damit nachfolgende Suites den Default-State sehen.
  prompts.configurePrompts(cfg, 'claude');
});

test('Systemprompt trägt Rolle + „leerer Output > falscher Output"-Haltung', () => {
  prompts.configurePrompts(cfg, 'claude');
  const sys = prompts.SYSTEM_LEKTORAT || '';
  assert.ok(/Lektor/i.test(sys), 'Systemprompt nennt die Lektor-Rolle');
  assert.ok(/Leerer Output ist besser/i.test(sys), 'Systemprompt trägt die Konservativ-Haltung');
});

// ── Buchtyp-Profile ──────────────────────────────────────────────────────────
// Der Buchtyp waehlt das Fehlertyp-Set (public/js/prompts/lektorat-typen.js). Diese
// Tests verankern, dass die Umschaltung im GEBAUTEN Prompt ankommt — nicht nur in
// der Profil-Tabelle. Vorher erreichte `buchtyp` den Lektorat-Prompt nur als
// Kontext-Zusatz und ueber den Erzaehlform-Block; die Regelbloecke blieben global.

function buildWissenschaft(opts = {}) {
  prompts.configurePrompts(cfg, 'claude');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'wissenschaft', ...opts });
}

test('Wissenschafts-Prompt fordert keine narrativen Regelbloecke an', () => {
  const p = buildWissenschaft();
  for (const block of ['Show-vs-Tell-Regeln', 'Filterwort-Regeln', 'Klischee-Regeln',
    'KI-Geruch-Regeln', 'Passivkonstruktionen-Regeln', 'Perspektivbruch-Regeln',
    'Dialogformat-Regeln', 'Schwache-Verben-Regeln', 'Figurenkonsistenz-Regeln',
    'Schauplatzkonsistenz-Regeln']) {
    assert.ok(!p.includes(block), `Wissenschaft: Block «${block}» darf nicht drin sein`);
  }
  // Auch nicht im Typ-Enum.
  const enumLine = p.split('\n').find(l => l.includes('"typ": "'));
  assert.ok(enumLine, 'Typ-Enum-Zeile fehlt');
  for (const typ of ['show_vs_tell', 'klischee', 'schwaches_verb', 'filterwort',
    'ki_geruch', 'passiv', 'perspektivbruch', 'dialogformat', 'namenskonsistenz']) {
    assert.ok(!enumLine.includes(typ), `Wissenschaft: Typ «${typ}» darf nicht im Enum stehen`);
  }
});

test('Wissenschafts-Prompt bringt die vier Fach-Regelbloecke + Fach-Varianten', () => {
  const p = buildWissenschaft();
  for (const block of ['Beleg-Regeln (typ: «unbelegt»)', 'Begriffs-Regeln (typ: «begriffsinkonsistenz»)',
    'Autorenreferenz-Regeln (typ: «autorenform»)', 'Hedging-Regeln (typ: «hedging»)',
    'Tempus-Regeln (typ: «tempuswechsel»)', 'Teilabschnitts-Regeln']) {
    assert.ok(p.includes(block), `Wissenschaft: Block «${block}» fehlt`);
  }
  // Die Fach-Wiederholungsregel muss Fachtermini ausnehmen, sonst arbeitet sie gegen
  // begriffsinkonsistenz (Terminus MUSS wortgleich wiederholt werden).
  assert.ok(/VORRANG-REGEL: Fachbegriffe/.test(p), 'Fachbegriff-Ausnahme in wiederholung fehlt');
  // Und der Prompt muss Nominalstil/Passiv ausdruecklich freigeben.
  assert.ok(/Nominalstil/.test(p), 'Nominalstil-Freigabe fehlt');
  // Kein erfundener Beleg im korrektur-Feld.
  assert.ok(/Erfinde NIEMALS einen Beleg/.test(p), 'Beleg-Erfindungs-Verbot fehlt');
  assert.ok(/BELEG-ERFINDUNG/.test(p), 'Selbstkontroll-Schritt gegen erfundene Belege fehlt');
});

test('Wissenschafts-Prompt behaelt die Puritaets-Invarianten', () => {
  const p = buildWissenschaft();
  for (const [label, needle] of CLOUD_INVARIANTS) {
    assert.ok(p.includes(needle), `Wissenschaft-Prompt fehlt Block: ${label} («${needle}»)`);
  }
});

test('Erzaehlform-Block entfaellt in den Fach-Profilen', () => {
  const opts = { erzaehlperspektive: '1. Person (Ich-Erzähler)', erzaehlzeit: 'Präteritum' };
  const roman = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'roman', ...opts });
  const wiss = buildWissenschaft(opts);
  assert.ok(roman.includes('Etablierte Erzählform des Buchs'), 'Roman: Erzählform-Block muss bleiben');
  assert.ok(!wiss.includes('Etablierte Erzählform des Buchs'), 'Wissenschaft: kein Erzählform-Block');
});

test('Sachbuch-Prompt: Erzaehl-Handwerk weg, Hedging + Begriffsdisziplin da', () => {
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'sachbuch' });
  assert.ok(!p.includes('Show-vs-Tell-Regeln'), 'Sachbuch: kein Show-vs-Tell');
  assert.ok(!p.includes('Filterwort-Regeln'), 'Sachbuch: kein Filterwort');
  assert.ok(p.includes('Hedging-Regeln'), 'Sachbuch: Hedging fehlt');
  assert.ok(p.includes('Begriffs-Regeln'), 'Sachbuch: Begriffsdisziplin fehlt');
  // Starke Verben und Aktiv bleiben in Sachtexten Ziel – anders als in der Arbeit.
  assert.ok(p.includes('Schwache-Verben-Regeln'), 'Sachbuch: schwaches_verb muss bleiben');
  assert.ok(p.includes('Passivkonstruktionen-Regeln'), 'Sachbuch: passiv muss bleiben');
});

test('Objektiv-Pass schrumpft im Fach-Profil auf reine Mechanik', () => {
  prompts.configurePrompts(cfg, 'claude');
  const figuren = [{ name: 'Anna', geschlecht: 'weiblich' }];
  const roman = prompts.buildObjektivLektoratPrompt(SAMPLE, { buchtyp: 'roman', figuren });
  const wiss = prompts.buildObjektivLektoratPrompt(SAMPLE, { buchtyp: 'wissenschaft', figuren });
  assert.ok(roman.includes('Dialogformat-Regeln'), 'Roman: Dialogformat gehört in den Objektiv-Pass');
  assert.ok(roman.includes('Figurenkonsistenz-Regeln'), 'Roman: Figurenkonsistenz gehört dazu');
  assert.ok(!wiss.includes('Dialogformat-Regeln'), 'Wissenschaft: kein Dialogformat');
  assert.ok(!wiss.includes('Figurenkonsistenz-Regeln'), 'Wissenschaft: keine Figurenkonsistenz');
  assert.ok(wiss.includes('"typ": "rechtschreibung|grammatik"'), 'Wissenschaft: Enum auf Mechanik reduziert');
  // Der Verbots-Katalog muss die Fach-Typen nennen, nicht die narrativen.
  assert.ok(/VERBOTEN[^\n]*hedging/.test(wiss), 'Wissenschaft: hedging fehlt im Verbots-Katalog');
  assert.ok(!/VERBOTEN[^\n]*show_vs_tell/.test(wiss), 'Wissenschaft: show_vs_tell hat im Verbot nichts zu suchen');
});

test('Schema-Enum und Prompt-Enum tragen dasselbe Typ-Set', () => {
  prompts.configurePrompts(cfg, 'claude');
  for (const buchtyp of ['roman', 'sachbuch', 'wissenschaft']) {
    const p = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp });
    const enumLine = p.split('\n').find(l => l.includes('"typ": "'));
    const promptTypen = enumLine.match(/"typ": "([^"]+)"/)[1].split('|');
    const schemaTypen = prompts.buildLektoratSchema({ buchtyp })
      .properties.fehler.items.properties.typ.enum;
    assert.deepEqual(schemaTypen, promptTypen, `${buchtyp}: Grammar und Prompt-Text weichen ab`);
  }
});

// ── Tagebuch: Bewertungseinheit «Eintrag» ─────────────────────────────────────
// Das Tagebuch laeuft bewusst auf dem narrativen Profil (die Fehlertypen passen), hat
// aber eine eigene Einheit fuer das Feld «szenen». Ohne sie benotete das Lektorat
// jeden Tagebucheintrag als Szene – «abgegrenzter Handlungsabschnitt mit eigenem
// Anfang und Ende», gemessen an Spannung, Tempo und Figurenentwicklung – und
// schlug Szenenfutter vor, wo der Autor eine Notiz schrieb. Verankert ist hier nur,
// dass die Unterscheidung im GEBAUTEN Prompt ankommt; die Qualitaet der Noten ist
// Sache von `npm run eval:lektorat`.

function buildTagebuch(opts = {}) {
  prompts.configurePrompts(cfg, 'claude');
  return prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'tagebuch', ...opts });
}

test('Tagebuch-Prompt benotet Eintraege, keine Szenen', () => {
  const p = buildTagebuch();
  assert.ok(p.includes('Eintrag-Regeln (Feld «szenen»)'), 'Eintrag-Regeln fehlen');
  assert.ok(!p.includes('Szenen-Regeln:'), 'Tagebuch darf keine Szenen-Regeln bekommen');
  assert.ok(!p.includes('Teilabschnitts-Regeln'), 'Tagebuch darf keine Teilabschnitts-Regeln bekommen');
  // Auch die Schema-Felder und die Aufgabenzeile muessen dieselbe Einheit nennen –
  // sonst verspricht das Schema eine Szenenbezeichnung, die die Regeln nicht kennen.
  assert.ok(p.includes('Bezeichnung des Eintrags'), 'Schema-Feld titel nennt nicht den Eintrag');
  assert.ok(p.includes('trägt die Stimme des Eintrags'), 'Schema-Feld kommentar nennt nicht die Stimme');
  assert.ok(p.includes('Bewerte ausserdem die Einträge des Abschnitts.'), 'Aufgabe benennt nicht die Einträge');
  // Die genretypische Kuerze muss ausdruecklich freigegeben sein, sonst landet
  // «bleibt Notizstenografie» wieder als «mittel» in der Notenliste.
  assert.ok(p.includes('sind genretypisch und KEIN Mangel dieses Feldes'),
    'Tagebuch: genretypische Kürze nicht freigegeben');
});

test('Tagebuch-Prompt verengt show_vs_tell,-Roman-Prompt nicht', () => {
  const tag = buildTagebuch();
  const roman = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'roman' });
  // Tagebuch: behaupteter statt beobachteter Zustand, kein «wäre lebendiger».
  assert.ok(tag.includes('BEHAUPTET statt beobachtet'), 'Tagebuch: verengte Meldeschwelle fehlt');
  assert.ok(!tag.includes('spürbar lebendiger macht'), 'Tagebuch: narrative Schwelle darf nicht drin sein');
  assert.ok(tag.includes('NICHTS ergänzen, was nicht im Material steht'),
    'Tagebuch: Erfindungsverbot für die Korrektur fehlt');
  // Regression: die Schwelle der anderen Einheiten bleibt unberuehrt.
  assert.ok(roman.includes('spürbar lebendiger macht'), 'Roman: narrative Schwelle muss bleiben');
  assert.ok(!roman.includes('BEHAUPTET statt beobachtet'), 'Roman: darf nicht die Tagebuch-Schwelle tragen');
  // Und der Typ selbst bleibt in beiden – er wird verengt, nicht abgeschaltet.
  for (const p of [tag, roman]) {
    assert.ok(p.includes('Show-vs-Tell-Regeln'), 'Show-vs-Tell-Block muss bleiben');
    assert.ok(p.includes('show_vs_tell'), 'show_vs_tell muss im Enum bleiben');
  }
});

test('Tagebuch-Prompt behaelt die Puritaets-Invarianten des narrativen Profils', () => {
  // Mit Figuren: der Block haengt an der Figurenkartei, nicht am Buchtyp – ohne sie
  // pruefte der Test den falschen Grund.
  const p = buildTagebuch({ figuren: [{ name: 'Anna', geschlecht: 'weiblich' }] });
  for (const [label, needle] of CLOUD_INVARIANTS) {
    assert.ok(p.includes(needle), `Tagebuch-Prompt fehlt Block: ${label} («${needle}»)`);
  }
  // Der Einheitenwechsel darf das Erzähl-Handwerk nicht mitschleifen: Tagebuch
  // braucht show_vs_tell/filterwort/figurenbezogene Typen weiterhin.
  for (const block of ['Show-vs-Tell-Regeln', 'Filterwort-Regeln', 'Figurenkonsistenz-Regeln']) {
    assert.ok(p.includes(block), `Tagebuch: Block «${block}» muss bleiben`);
  }
});

test('Nachbarkontext: im Tagebuch ist der harte Szenenwechsel der Normalfall', () => {
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.buildStilLektoratPrompt(SAMPLE, {
    langCode: 'de', buchtyp: 'tagebuch', previousExcerpt: 'VORHER', nextExcerpt: 'NACHHER',
  });
  assert.ok(p.includes('ohne Überleitung zum nächsten weitergeht, nicht'),
    'Tagebuch-Nachbarkontext muss den harten Wechsel freigeben');
  const roman = prompts.buildStilLektoratPrompt(SAMPLE, {
    langCode: 'de', buchtyp: 'roman', previousExcerpt: 'VORHER', nextExcerpt: 'NACHHER',
  });
  assert.ok(roman.includes('scheinbar abrupter Schluss bewusst offen bleibt'),
    'Roman-Nachbarkontext muss unverändert bleiben');
});

// Nachbarseiten-Kontext: Cloud bekommt Vor- und Folgeseite als abgegrenzten
// Lesekontext mit Pruef-Verbot; lokal faellt der Block ganz weg.
test('Nachbarkontext: Cloud rahmt Vor- und Folgeseite als nicht zu pruefen', () => {
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.buildStilLektoratPrompt(SAMPLE, {
    langCode: 'de', previousExcerpt: 'VORHER-AUSZUG', nextExcerpt: 'NACHHER-AUSZUG',
  });
  assert.ok(p.includes('<nachbarkontext>'));
  assert.ok(p.includes('<vorherige_seite') && p.includes('VORHER-AUSZUG'));
  assert.ok(p.includes('<naechste_seite') && p.includes('NACHHER-AUSZUG'));
  assert.ok(p.includes('ausschliesslich aus <originaltext>'), 'Pruef-Verbot fehlt');
  assert.ok(p.indexOf('</nachbarkontext>') < p.lastIndexOf('<originaltext label'), 'Kontext muss vor dem Originaltext stehen');
});

test('Nachbarkontext: ohne Auszuege kein Block, lokal nie', () => {
  prompts.configurePrompts(cfg, 'claude');
  assert.ok(!prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' }).includes('<nachbarkontext>'));
  prompts.configurePrompts(cfg, 'ollama');
  const local = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', previousExcerpt: 'a', nextExcerpt: 'b' });
  assert.ok(!local.includes('<nachbarkontext>'));
});

// Nachbarn aus einem anderen Kapitel tragen ihr Kapitel im Label und die
// Freigabe des harten Schnitts — sonst läse das Modell den Kapitelwechsel als Bruch.
test('Nachbarkontext: Auszug aus anderem Kapitel ist als Kapitelwechsel gekennzeichnet', () => {
  prompts.configurePrompts(cfg, 'claude');
  const p = prompts.buildLektoratPrompt(SAMPLE, {
    langCode: 'de', previousExcerpt: 'VORHER', nextExcerpt: 'NACHHER', previousChapter: 'Ankunft', nextChapter: null,
  });
  assert.ok(p.includes('Letzter Absatz des vorherigen Kapitels «Ankunft» (Kapitelwechsel)'));
  assert.ok(p.includes('Erster Absatz des nächsten Abschnitts'), 'gleiches Kapitel bleibt «Abschnitt»');
  assert.ok(p.includes('an dieser Grenze normal und kein Bruch'));
  const ohne = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', previousExcerpt: 'VORHER', nextExcerpt: 'NACHHER' });
  assert.ok(!ohne.includes('Kapitelwechsel'), 'ohne Kapitelwechsel keine Kennzeichnung');
});

// Schreibstelle: im unfertigen Werk ohne Folgetext ist die angefangene letzte
// Einheit kein Befund — in allen Pässen, die sie werten könnten.
test('Schreibstelle: angefangene letzte Szene ist kein Befund (Kombi, Stil, Objektiv), lokal nie', () => {
  prompts.configurePrompts(cfg, 'claude');
  const roman = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'roman', schreibfront: true });
  assert.ok(roman.includes('SCHREIBSTELLE') && roman.includes('die letzte Szene'));
  assert.ok(roman.includes('noch in «szenen»'));
  const fach = prompts.buildStilLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'sachbuch', schreibfront: true });
  assert.ok(fach.includes('der letzte Gedankengang') && !fach.includes('noch in «szenen»'));
  const obj = prompts.buildObjektivLektoratPrompt(SAMPLE, { langCode: 'de', schreibfront: true });
  assert.ok(obj.includes('KEIN «grammatik»-Befund'));
  assert.ok(!prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' }).includes('SCHREIBSTELLE'));
  assert.ok(!prompts.buildObjektivLektoratPrompt(SAMPLE, { langCode: 'de' }).includes('SCHREIBSTELLE'));
  prompts.configurePrompts(cfg, 'ollama');
  assert.ok(!prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', schreibfront: true }).includes('SCHREIBSTELLE'));
  prompts.configurePrompts(cfg, 'claude');
});

// Die Stil-Obergrenze im Prompt folgt `stylisticCap` (Server: ai.lektorat_stylistic_cap).
// Ein fest verdrahteter Wert liefe gegen den Handler-Backstop auseinander, der nach
// Textposition kappt — dann fielen die guten Funde am Seitenende weg.
test('Stil-Obergrenze im Prompt folgt stylisticCap (narrativ + Fach, Kombi + Stil-Pass)', () => {
  prompts.configurePrompts(cfg, 'claude');
  const narrativ = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', stylisticCap: 7 });
  assert.match(narrativ, /mehr als 7 solcher stilistischen Einträge/);
  assert.match(narrativ, /nur die schwersten 7 behalten/);
  assert.doesNotMatch(narrativ, /~20/);
  const stil = prompts.buildStilLektoratPrompt(SAMPLE, { langCode: 'de', stylisticCap: 7 });
  assert.match(stil, /nur die schwersten 7 behalten/);
  const fach = prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de', buchtyp: 'sachbuch', stylisticCap: 7 });
  assert.match(fach, /nur die schwersten 7 behalten/);
  assert.match(prompts.buildLektoratPrompt(SAMPLE, { langCode: 'de' }), /nur die schwersten 10 behalten/);
});
