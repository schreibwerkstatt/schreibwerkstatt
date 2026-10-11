'use strict';
// Aggregierte Token-Verbrauchsstatistik pro Tag.
// Quelle: das persistente Kosten-Ledger (db/cost-ledger / Tabelle
// ai_cost_ledger). Es traegt Job- und Chat-Verbrauch bereits getrennt (Spalte
// `source`) und ueberlebt den Aufbewahrungs-Prune von job_runs — daher schrumpfen
// aeltere Tage nicht mehr.
//
// Granularität: Tag × User × Provider × Modell × Quelle/Typ.
// Cache-Tokens (Claude) werden in cache_read_in (billig) und cache_creation_in (teuer)
// getrennt geführt. Lokale Provider liefern dort 0.
const { db } = require('./connection');

/**
 * @param {object} opts
 * @param {string} [opts.from]         ISO-Datum oder YYYY-MM-DD (inklusive). Default: 30 Tage zurück.
 * @param {string} [opts.to]           ISO-Datum oder YYYY-MM-DD (inklusive, exklusive Tagesgrenze).
 * @param {string} [opts.userEmail]    Filter auf einen User. Ohne: alle.
 * @param {string} [opts.provider]     Filter auf einen Provider (claude/ollama/llama).
 * @param {string} [opts.source]       'job' | 'chat' | 'all' (default).
 * @returns {Array<{day:string,userEmail:string,provider:string,model:string,source:string,type:string,calls:number,tokensIn:number,tokensOut:number,cacheReadIn:number,cacheCreationIn:number,cacheCreation1hIn:number}>}
 */
function getDailyTokenUsage({ from, to, userEmail, provider, source = 'all' } = {}) {
  const fromIso = from || new Date(Date.now() - 30 * 86400_000).toISOString();
  const toIso = to || new Date(Date.now() + 86400_000).toISOString();

  const where = ['ts >= @from', 'ts < @to'];
  if (userEmail) where.push('user_email = @userEmail');
  if (provider)  where.push('provider = @provider');
  if (source === 'job' || source === 'chat') where.push('source = @source');

  return db.prepare(`
    SELECT
      substr(ts, 1, 10) AS day,
      user_email        AS userEmail,
      provider,
      model,
      source,
      type,
      COUNT(*)                               AS calls,
      COALESCE(SUM(tokens_in), 0)            AS tokensIn,
      COALESCE(SUM(tokens_out), 0)           AS tokensOut,
      COALESCE(SUM(cache_read_in), 0)        AS cacheReadIn,
      COALESCE(SUM(cache_creation_in), 0)    AS cacheCreationIn,
      COALESCE(SUM(cache_creation_1h_in), 0) AS cacheCreation1hIn
    FROM ai_cost_ledger
    WHERE ${where.join(' AND ')}
    GROUP BY day, user_email, provider, model, source, type
    ORDER BY day DESC, userEmail, provider, source, type
  `).all({
    from: fromIso, to: toIso,
    userEmail: userEmail || null,
    provider: provider || null,
    source: source || null,
  });
}

/**
 * Tagessummen pro User über ALLE Provider/Modelle/Typen hinweg.
 * Für High-Level-Reports „User X heute Y Tokens".
 */
function getDailyTotalsByUser({ from, to, userEmail } = {}) {
  const rows = getDailyTokenUsage({ from, to, userEmail });
  const byKey = new Map();
  for (const r of rows) {
    const key = `${r.day}\t${r.userEmail || ''}\t${r.provider || ''}`;
    const acc = byKey.get(key) || {
      day: r.day, userEmail: r.userEmail, provider: r.provider,
      calls: 0, tokensIn: 0, tokensOut: 0, cacheReadIn: 0, cacheCreationIn: 0, cacheCreation1hIn: 0,
    };
    acc.calls             += r.calls;
    acc.tokensIn          += r.tokensIn;
    acc.tokensOut         += r.tokensOut;
    acc.cacheReadIn       += r.cacheReadIn;
    acc.cacheCreationIn   += r.cacheCreationIn;
    acc.cacheCreation1hIn += r.cacheCreation1hIn;
    byKey.set(key, acc);
  }
  return [...byKey.values()].sort((a, b) =>
    b.day.localeCompare(a.day) || (a.userEmail || '').localeCompare(b.userEmail || '')
  );
}

module.exports = { getDailyTokenUsage, getDailyTotalsByUser };
