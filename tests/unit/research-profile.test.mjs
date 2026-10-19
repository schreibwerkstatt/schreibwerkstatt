// Recherche-Profil: Normalisierung der Domain-Eingrenzung (lib/research-profile.js)
// und ihre Wirkung im gebauten Recherche-Chat-Prompt + Werkzeugsatz.
//
// Warum die Prompt-Haelfte mitgetestet wird: die Eingrenzung ist erst dann
// vollstaendig, wenn das Modell sie AUCH IM TEXT sieht — `allowed_domains`
// allein macht aus „dort nichts gefunden" ein „gibt es nicht".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rp = require('../../lib/research-profile.js');
const prompts = await import('../../public/js/prompts/recherche.js');

test('normalizeDomain: ganze URLs, www und Grossschrift werden zum blanken Host', () => {
  assert.equal(rp.normalizeDomain('https://pubmed.ncbi.nlm.nih.gov/?term=x'), 'pubmed.ncbi.nlm.nih.gov');
  assert.equal(rp.normalizeDomain('www.Cochranelibrary.com'), 'cochranelibrary.com');
  assert.equal(rp.normalizeDomain('  europepmc.org/  '), 'europepmc.org');
  assert.equal(rp.normalizeDomain('http://example.org:8080/pfad'), 'example.org');
});

test('normalizeDomain: IDN wird zu Punycode', () => {
  assert.equal(rp.normalizeDomain('münchen.de'), 'xn--mnchen-3ya.de');
});

test('normalizeDomain: unbrauchbare Eingaben fallen weg statt Unsinn zu speichern', () => {
  // Ohne Punkt ist es kein Host; eine nackte IP waere ein Weg an der Domain-Idee
  // vorbei; leere Eingabe ist kein Wert.
  assert.equal(rp.normalizeDomain('localhost'), null);
  assert.equal(rp.normalizeDomain('127.0.0.1'), null);
  assert.equal(rp.normalizeDomain(''), null);
  assert.equal(rp.normalizeDomain(null), null);
});

test('normalizeDomains: dedupliziert, haelt die Reihenfolge und deckelt', () => {
  assert.deepEqual(
    rp.normalizeDomains('a.de\nb.de, a.de; https://b.de/x'),
    ['a.de', 'b.de'],
  );
  const viele = Array.from({ length: 40 }, (_, i) => `d${i}.example`).join('\n');
  assert.equal(rp.normalizeDomains(viele).length, rp.MAX_DOMAINS);
});

test('serializeDomains/parseDomains sind zueinander invers, leer wird NULL', () => {
  assert.equal(rp.serializeDomains([]), null);
  assert.equal(rp.serializeDomains('   '), null);
  assert.deepEqual(rp.parseDomains(rp.serializeDomains('a.de\nb.de')), ['a.de', 'b.de']);
  assert.deepEqual(rp.parseDomains(null), []);
});

test('normalizeProfile: trimmt, deckelt, leer wird NULL', () => {
  assert.equal(rp.normalizeProfile('  Text  '), 'Text');
  assert.equal(rp.normalizeProfile('   '), null);
  assert.equal(rp.normalizeProfile('x'.repeat(5000)).length, rp.RESEARCH_PROFILE_MAX);
});

test('Prompt: ohne Profil bleibt der Block WEG statt Leere zu behaupten', () => {
  const p = prompts.buildResearchChatAgentSystemPrompt('Buch', 0, 6, [], [], {});
  assert.ok(!p.includes('VORRANGIGE ANGABEN DER AUTORIN'));
  assert.ok(!p.includes('EINGRENZUNG DER WEB-SUCHE'));
});

test('Prompt: die Domain-Eingrenzung steht im Text und benennt die Domains', () => {
  const p = prompts.buildResearchChatAgentSystemPrompt('Buch', 0, 6, [], [], {
    text: 'Nur peer-reviewte Studien.',
    domains: ['pubmed.ncbi.nlm.nih.gov', 'europepmc.org'],
  });
  assert.ok(p.includes('VORRANGIGE ANGABEN DER AUTORIN'));
  assert.ok(p.includes('Nur peer-reviewte Studien.'));
  assert.ok(p.includes('EINGRENZUNG DER WEB-SUCHE'));
  assert.ok(p.includes('pubmed.ncbi.nlm.nih.gov'));
  // Der teuerste Fehler waere eine Fehlanzeige, die keine ist.
  assert.ok(/behaupte nie, es gebe die Information nicht/i.test(p));
});

test('Werkzeugsatz: allowed_domains nur mit Domains, sonst unveraendert', () => {
  const ohne = prompts.buildResearchChatTools();
  assert.equal(ohne, prompts.RESEARCH_CHAT_TOOLS);
  assert.ok(!ohne.find(t => t.name === 'web_search').allowed_domains);

  const mit = prompts.buildResearchChatTools({ allowedDomains: ['a.de'] });
  assert.deepEqual(mit.find(t => t.name === 'web_search').allowed_domains, ['a.de']);
  // Leeres Array waere fuer die API eine Eingrenzung auf nichts.
  assert.ok(!prompts.buildResearchChatTools({ allowedDomains: [] })
    .find(t => t.name === 'web_search').allowed_domains);
  // Die Basisliste darf der Builder nicht mutieren.
  assert.ok(!prompts.RESEARCH_CHAT_TOOLS.find(t => t.name === 'web_search').allowed_domains);
  assert.equal(mit.length, prompts.RESEARCH_CHAT_TOOLS.length);
});

test('Werkzeugsatz SearXNG: Function-Tools statt Server-Tool, Rest unverändert', () => {
  const tools = prompts.buildResearchChatTools({ allowedDomains: ['a.de'], webSearchMode: 'searxng' });
  const web = tools.filter(t => t.name === 'web_search');
  assert.equal(web.length, 1);
  assert.equal(web[0].type, undefined, 'kein Server-Tool');
  assert.equal(web[0].max_uses, undefined);
  assert.equal(web[0].allowed_domains, undefined, 'Eingrenzung erzwingt der Handler');
  assert.ok(web[0].input_schema.required.includes('query'));
  assert.ok(tools.find(t => t.name === 'read_web_page'));
  assert.equal(tools.length, prompts.RESEARCH_CHAT_TOOLS.length + 1);
  for (const t of prompts.RESEARCH_CHAT_TOOLS.filter(x => x.name !== 'web_search' && x.name !== 'final_answer')) {
    assert.ok(tools.includes(t), `${t.name} bleibt dasselbe Objekt`);
  }
  // final_answer: [nr]-Belege statt eigener Nummerierung nach der Quellenliste.
  const fin = tools.find(t => t.name === 'final_answer');
  assert.ok(fin.description.includes('`nr`'));
  assert.ok(!/Reihenfolge = Nummerierung/.test(fin.input_schema.properties.quellen.description));
  assert.deepEqual(fin.input_schema.required, ['antwort']);
  // Der Default bleibt der Anthropic-Satz.
  assert.equal(prompts.buildResearchChatTools({ webSearchMode: 'anthropic' }), prompts.RESEARCH_CHAT_TOOLS);
});

test('Prompt SearXNG: read_web_page + [nr]-Belege, Anthropic-Prompt ohne beides', () => {
  const sx = prompts.buildResearchChatAgentSystemPrompt('Buch', 0, 6, [], [], {}, { maxWebSearches: 10, webSearchMode: 'searxng' });
  assert.ok(sx.includes('`read_web_page`'));
  assert.ok(sx.includes('[3]'));
  assert.ok(sx.includes('kostet Zeit'));
  const an = prompts.buildResearchChatAgentSystemPrompt('Buch', 0, 6, [], [], {}, { maxWebSearches: 10 });
  assert.ok(!an.includes('read_web_page'));
  assert.ok(!an.includes('[3]'));
  assert.ok(!an.includes('kostet Zeit'));
});

test('Schlussrunde SearXNG: Anweisung wiederholt die [nr]-Regel, Anthropic-Fassung nicht', () => {
  assert.ok(prompts.RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION_SEARXNG.startsWith(prompts.RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION));
  assert.ok(prompts.RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION_SEARXNG.includes('`nr`'));
  assert.ok(!prompts.RESEARCH_CHAT_FORCE_FINAL_INSTRUCTION.includes('`nr`'));
});
