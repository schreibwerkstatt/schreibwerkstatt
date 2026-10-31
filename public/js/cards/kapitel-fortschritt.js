// Kapitel-Dashboard, Kachel „Fortschritt" — wie weit die Abschnitte des
// Kapitels sind, und welche davon liegen bleiben.
//
// Achse ist der Bearbeitungsstand (docs/bearbeitungsstand.md): die vom User
// gesetzte Stufe je Abschnitt aus `$store.badges.editStatus`, geordnet nach der
// Kette des Buchs (`editStatusChain`). Verteilung ueber dieselbe Funktion wie die
// Buchuebersicht (redaktion/status.js#statusDistribution) — eine zweite Zaehlung
// daneben wuerde driften. Kein KI-Call, kein Endpunkt.
//
// „Liegt brach": ein Abschnitt, der die letzte Stufe der Kette noch nicht
// erreicht hat und seit mindestens BRACH_DAYS Kalendertagen (App-Zeitzone) nicht
// gespeichert wurde. Ein fertiger Abschnitt, der lange ruht, ist erledigt, nicht
// liegen geblieben.
import { localDayDiff } from '../utils.js';
import { statusDistribution } from '../redaktion/status.js';
import { compareText } from '../i18n.js';

export const BRACH_DAYS = 30;

/** Verteilung der Stufen im Scope plus die am laengsten liegenden unfertigen
 *  Abschnitte. `now` ist injizierbar (Tests). Segment-Klassen (`status<Rang>`,
 *  `ohne`) sind die der Buchuebersicht. */
export function computeFortschritt(pages, byPage, chain,
  { now = new Date(), brachDays = BRACH_DAYS, limit = 5 } = {}) {
  const list = pages || [];
  const stufen = chain || [];
  const counts = statusDistribution(list.map(p => p.id), byPage, stufen);
  const done = stufen.length ? stufen[stufen.length - 1] : null;
  const segments = [
    ...stufen.map((s, rank) => ({ key: s, cls: 'status' + rank, n: counts[s] })),
    { key: 'ohne', cls: 'ohne', n: counts.ohne },
  ].filter(s => s.n > 0);

  const brach = [];
  for (const p of list) {
    const status = byPage?.[String(p.id)]?.status || null;
    if (done && status === done) continue;
    if (!p.updated_at) continue;
    const days = localDayDiff(p.updated_at, now);
    if (Number.isFinite(days) && days >= brachDays) {
      brach.push({ page: p, name: p.name, status, days });
    }
  }
  brach.sort((a, b) => b.days - a.days || compareText(a.name, b.name));

  return {
    total: list.length,
    set: list.length - counts.ohne,
    done,
    doneN: done ? counts[done] : 0,
    stale: counts.stale,
    segments,
    brachDays,
    brachTotal: brach.length,
    brach: brach.slice(0, limit),
  };
}
