// Plot-Werkstatt: Zeilen-Renderer der Kontext-Listen (Figuren, Orte, Zeitstrahl,
// Kontinuität, Recherche, Werkstatt-Figuren, Kapitel, Beziehungen, Szenen,
// Weltgesetze). Pure Funktionen ohne Zustand; die Kappung der Listen entscheidet
// der Job (routes/jobs/plot/context.js) und weist sie über `kuerzungen` aus —
// hier wird nur gerendert.
//
// Inhalte, die aus dem Buchprojekt stammen und Freitext tragen (Beschreibungen,
// Recherche-Inhalte, frühere Befunde), stehen in «…»: der Prompt erklärt diese
// Klammern als Daten, nicht als Anweisungen (DATEN_REGEL in board.js).

export function _trunc(s, max = 280) {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

// Wie _trunc, schneidet aber an einer Wortgrenze (sofern eine im letzten Drittel
// liegt) statt mitten im Wort. Für sichtbare Fliesstext-Auszüge (Beat-Beschreibung).
export function _truncWord(s, max = 200) {
  const t = (s || '').trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  const base = sp > max * 0.66 ? cut.slice(0, sp) : cut;
  return `${base.replace(/[\s,;:.–-]+$/, '')}…`;
}

// Beziehungen einer Figur (Soziogramm): „Partner (Typ)". `mit` ist bereits ein
// aufgelöster Name (der Job übersetzt die fig_id vor dem Prompt-Bau).
function _relLine(beziehungen) {
  const rels = (beziehungen || []).filter(b => b && b.mit).slice(0, 12);
  if (!rels.length) return '';
  return `\n  Beziehungen: ${rels.map(b => `${b.mit}${b.typ ? ` (${b.typ})` : ''}`).join('; ')}`;
}

// Lebensereignisse einer Figur (Figuren-Zeitstrahl): „Datum: Ereignis [Kapitel]".
function _eventsLine(lebensereignisse) {
  const evs = (lebensereignisse || []).filter(e => e && e.ereignis).slice(0, 10);
  if (!evs.length) return '';
  return `\n  Ereignisse: ${evs.map(e => `${e.datum ? `${e.datum}: ` : ''}${e.ereignis}${e.kapitel ? ` [${e.kapitel}]` : ''}`).join(' · ')}`;
}

// Detaillierter Figuren-Block für BEIDE Jobs: Name + Kurzname, Rollen-Meta
// (Typ/Beruf/Geschlecht), Tags, gekürzte Beschreibung und — sofern vorhanden —
// Beziehungen (Soziogramm) + Lebensereignisse (Zeitstrahl).
export function _figurenLinesDetail(figuren) {
  return (figuren || [])
    .map(f => {
      const meta = [f.typ, f.beruf, f.geschlecht].filter(Boolean).join(', ');
      const head = `- ${f.name}${f.kurzname ? ` („${f.kurzname}")` : ''}${meta ? ` [${meta}]` : ''}`;
      const besch = f.beschreibung ? `\n  ${_trunc(f.beschreibung)}` : '';
      const tags = (f.tags || []).length ? `\n  Tags: ${f.tags.join(', ')}` : '';
      return `${head}${besch}${tags}${_relLine(f.beziehungen)}${_eventsLine(f.lebensereignisse)}`;
    })
    .join('\n');
}

// Schauplätze des Buchs: Name + Typ/Stimmung + gekürzte Beschreibung.
export function _orteLines(orte) {
  return (orte || [])
    .map(o => {
      const meta = [o.typ, o.stimmung].filter(Boolean).join(', ');
      const besch = o.beschreibung ? `: ${_trunc(o.beschreibung, 160)}` : '';
      return `- ${o.name}${meta ? ` [${meta}]` : ''}${besch}`;
    })
    .join('\n');
}

// Buchweiter Figuren-Zeitstrahl (figure_events, chronologisch): „Datum — Ereignis
// (Figur) [Kapitel]". Grundlage für Chronologie-Prüfungen im Consistency-Check.
export function _zeitstrahlLines(zeitstrahl) {
  return (zeitstrahl || [])
    .map(e => {
      const d = e.datum ? `${e.datum} — ` : '';
      const fig = e.figur ? ` (${e.figur})` : '';
      const kap = e.kapitel ? ` [${e.kapitel}]` : '';
      return `- ${d}${e.ereignis}${fig}${kap}`;
    })
    .join('\n');
}

// Bekannte (offene) Kontinuitäts-Befunde aus dem letzten Continuity-Check. Ein
// Befund ohne Beschreibung trägt keine Aussage und fällt weg.
export function _kontinuitaetLines(issues) {
  return (issues || [])
    .filter(i => i && typeof i.beschreibung === 'string' && i.beschreibung.trim())
    .map(i => {
      const sev = i.schwere ? `[${i.schwere}] ` : '';
      const figs = (i.figuren || []).length ? ` (Figuren: ${i.figuren.join(', ')})` : '';
      const kap = (i.kapitel || []).length ? ` [${i.kapitel.join(', ')}]` : '';
      const emp = i.empfehlung ? `\n  Empfehlung: ${i.empfehlung}` : '';
      return `- ${sev}${i.beschreibung.trim()}${figs}${kap}${emp}`;
    })
    .join('\n');
}

// Verknüpfte Recherche-Fundstücke: Titel + gekürzter Inhalt «…» + Quelle + an
// welche Beats/Stränge sie der Autor geknüpft hat. Rückwärtsgewandt, NIE
// generativ: der Inhalt darf weder zitiert noch als Prosa übernommen werden.
export function _rechercheLines(recherche) {
  return (recherche || [])
    .map(r => {
      const anchor = [...(r.beats || []), ...(r.threads || [])];
      const an = anchor.length ? ` {zu: ${anchor.join(', ')}}` : '';
      const head = (r.title || '').trim() || '(ohne Titel)';
      const body = r.body ? `: «${_trunc(r.body, 240)}»` : '';
      const src = r.source ? ` (Quelle: ${_trunc(r.source, 80)})` : '';
      return `- ${head}${body}${src}${an}`;
    })
    .join('\n');
}

// Werkstatt-Figuren (Figuren-Werkstatt-Drafts): Name + optionaler Archetyp + —
// sofern in der Mindmap ausgearbeitet — die psychologischen Kerne
// (Want/Need/Wound/Lie + Bogen + Konflikt).
export function _werkstattFigurenLines(figuren) {
  return (figuren || [])
    .map(f => {
      const head = `- ${f.name}${f.archetype ? ` [${f.archetype}]` : ''}`;
      const p = f.psychologie;
      if (!p) return head;
      const parts = [];
      if ((p.want || []).length)     parts.push(`Will: ${_trunc(p.want.join('; '), 160)}`);
      if ((p.need || []).length)     parts.push(`Braucht: ${_trunc(p.need.join('; '), 160)}`);
      if ((p.wound || []).length)    parts.push(`Wunde: ${_trunc(p.wound.join('; '), 160)}`);
      if ((p.lie || []).length)      parts.push(`Lüge: ${_trunc(p.lie.join('; '), 160)}`);
      if ((p.bogen || []).length)    parts.push(`Bogen: ${_trunc(p.bogen.join(' → '), 200)}`);
      if ((p.konflikt || []).length) parts.push(`Konflikt: ${_trunc(p.konflikt.join('; '), 160)}`);
      return parts.length ? `${head}\n  ${parts.join(' · ')}` : head;
    })
    .join('\n');
}

// Kapitel chronologisch. Einträge sind Namen (String) oder `{ nr, name }` — Letzteres,
// wenn der Job die Liste gekappt hat: die Nummer bleibt die echte Buchposition,
// damit eine Auswahl nicht als lückenlose Folge erscheint.
export function _kapitelLines(kapitel) {
  return (kapitel || [])
    .map((k, i) => (k && typeof k === 'object')
      ? `${k.nr != null ? k.nr : i + 1}. ${k.name}`
      : `${i + 1}. ${k}`)
    .join('\n');
}

// Kuratierte Phrasen für die gerichteten Beat-Beziehungen (from --typ--> to).
// Freitext-Typen fallen auf „<typ> →" zurück (analog figure_relations).
export const REL_PHRASE = {
  'bereitet-vor': 'bereitet vor →',
  'zahlt-ein': 'zahlt ein auf →',
  'fuehrt-zu': 'führt zu →',
  'motiviert': 'motiviert →',
  'blockiert': 'blockiert →',
  'spiegelt': 'spiegelt →',
};

// Beat-zu-Beat-Beziehungen (Kausalität + Setup/Payoff): „[#a] «From» <Phrase> [#b] «To»".
export function _relationsLines(relations) {
  return (relations || [])
    .filter(r => r && r.from_titel && r.to_titel)
    .map(r => {
      const fid = r.from_beat_id != null ? `[#${r.from_beat_id}] ` : '';
      const tid = r.to_beat_id != null ? `[#${r.to_beat_id}] ` : '';
      return `- ${fid}«${r.from_titel}» ${REL_PHRASE[r.typ] || `${r.typ} →`} ${tid}«${r.to_titel}»`;
    })
    .join('\n');
}

// Szenen als „Buchrealität": Titel — Kapitel — beteiligte Figuren.
export function _szenenLines(szenen) {
  return (szenen || [])
    .map(s => {
      const kap = s.kapitel ? ` — ${s.kapitel}` : '';
      const figs = (s.figuren || []).length ? ` (${s.figuren.join(', ')})` : '';
      return `- ${s.titel}${kap}${figs}`;
    })
    .join('\n');
}

// Weltgesetze (world_facts, Kategorien regel/technik): was in dieser Welt GILT.
export function _weltgesetzeLines(weltgesetze) {
  return (weltgesetze || [])
    .filter(w => w && w.fakt)
    .map(w => {
      const subj = w.subjekt ? `${w.subjekt}: ` : '';
      const kap = (w.kapitel || []).length ? ` (etabliert in ${w.kapitel.slice(0, 3).join(', ')})` : '';
      return `- [${w.kategorie || 'regel'}] ${subj}${String(w.fakt).trim()}${kap}`;
    })
    .join('\n');
}

// Pendenzen des Autors an einem planenden Objekt (Ideen-Board, `idea_links`):
// offene sind ihm bekannt, verworfene hat er abgelehnt. SSoT der Textform — auch
// der Plot-Chat (routes/jobs/plot-chat-context.js) holt sie über die Facade
// (`ideenMarker`); die Daten liefert lib/idea-context.js#ideaNotesByTarget.
export function _ideenMarker(ideen) {
  if (!ideen || !ideen.length) return '';
  const offen = ideen.filter(i => i.status !== 'verworfen').map(i => `«${i.content}»`);
  const verw = ideen.filter(i => i.status === 'verworfen').map(i => `«${i.content}»`);
  const parts = [];
  if (offen.length) parts.push(`offene Pendenz des Autors (ihm bekannt, nicht als neuen Befund melden): ${offen.join('; ')}`);
  if (verw.length) parts.push(`vom Autor VERWORFEN (nicht erneut vorschlagen): ${verw.join('; ')}`);
  return `⟨${parts.join(' · ')}⟩`;
}

// Handlungsstränge (Swimlanes) als Block: Name + optional gebundene Hauptfigur +
// gebundenes Kapitel. Beats der Lane erben Figur + Kapitel implizit.
export function _straengeLines(threads) {
  return (threads || [])
    .map(t => {
      const fig = t.figur ? ` (Hauptfigur: ${t.figur})` : '';
      const kap = t.kapitel ? ` (Kapitel: ${t.kapitel})` : '';
      const ideen = _ideenMarker(t.ideen);
      return `- ${t.name}${fig}${kap}${ideen ? ` ${ideen}` : ''}`;
    })
    .join('\n');
}
