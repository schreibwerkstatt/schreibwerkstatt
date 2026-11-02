// Beilagen eines Fine-Tuning-Exports: Unsloth-Studio-Konfiguration und
// Ollama-Modelfile. Eine Quelle für den Download in der Karte
// (finetune-export.js) und das ZIP des Servers (routes/jobs/finetune-export,
// über lib/esm-bridge.js). `t(key, params)` übersetzt die Kommentarzeilen —
// im Browser `$app.t`, auf dem Server `tServerParams`.

import { finetuneProfileById, buildStudioYaml, studioSteps } from './finetune-profiles.js';
import { buildModelfile } from './finetune-modelfile.js';

/**
 * Studio-YAML. `stats` (gespeicherter Export, optional) liefert Train-Grösse
 * und die empfohlene Sequenzlänge: max_seq_length = `recommendedSeqLen`, mit
 * `tokensMax` und der Zahl längerer Beispiele als Hinweis. Ohne Export gilt
 * `maxSeqTokens` (Export-Feld) bzw. das Profil.
 */
export function studioYamlFor({ profileId, stats = null, maxSeqTokens = 0, t }) {
  const p = finetuneProfileById(profileId || stats?.profileId);
  const trainCount = Number(stats?.train) || 0;
  const steps = studioSteps(p, trainCount);
  const rec = Number(stats?.recommendedSeqLen) || 0;
  const seq = rec > 0 ? Math.min(rec, Number(stats?.maxSeqTokens) || rec) : (Number(maxSeqTokens) || 0);
  const header = [
    t('finetune.profile.yaml.title', { profile: t('finetune.profile.option', { model: p.name, vram: p.vramGb }) }),
    t('finetune.profile.yaml.model', { model: p.model }),
    t('finetune.profile.yaml.order'),
    t('finetune.profile.yaml.eval'),
    steps
      ? t('finetune.profile.yaml.steps', { train: trainCount, batch: p.batch, accum: p.accum, epochs: steps.epochs, total: steps.total, save: p.saveSteps || steps.save })
      : t('finetune.profile.yaml.noExport'),
  ];
  if (rec > 0) {
    header.push(t('finetune.profile.yaml.seqLen', {
      rec: seq, p95: stats.tokensP95 ?? '?', max: stats.tokensMax ?? '?', over: stats.overRecommendedSeq ?? 0,
    }));
  }
  header.push(t('finetune.profile.yaml.resume'));
  return buildStudioYaml(p, { maxSeqTokens: seq, trainCount, header });
}

/** Modelfile mit dem System-Prompt des Exports; null ohne System-Prompt. */
export function modelfileFor({ stats, bookName = '', t }) {
  if (!stats?.systemPrompt) return null;
  const p = finetuneProfileById(stats.profileId);
  return buildModelfile({
    systemPrompt: stats.systemPrompt,
    chatTemplate: p.chatTemplate,
    header: [
      t('finetune.modelfile.title', { book: bookName, model: p.name }),
      t('finetune.modelfile.from'),
      t('finetune.modelfile.system'),
      t('finetune.modelfile.build'),
      t('finetune.modelfile.repeat'),
    ],
  });
}
