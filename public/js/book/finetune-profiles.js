// Trainingsprofile der Fine-Tuning-Export-Karte: Basismodell × GPU-Speicher.
//
// Ein Profil trägt beides, was zusammenpassen muss — die Export-Vorgaben der
// Karte (Sequenz-Budget, Längenfenster) und die Unsloth-Studio-Konfiguration,
// die die Karte als `studio-config.yaml` zum Download anbietet. Pure Daten +
// Generator ohne Alpine, damit der Drift-Test gegen die Doku
// (docs/unsloth-config/studio-config.yaml, docs/finetuning.md) sie direkt lädt.
//
// YAML-Keys folgen Studios Import-Schema (Abschnitte training/lora/logging,
// gelesen von studio/frontend/src/features/training/lib/model-defaults.ts im
// Unsloth-Repo). Andere Keys ignoriert Studio still.

// Gemeinsam für alle Profile; ein Profil überschreibt nur, was vom
// GPU-Speicher abhängt.
//
// Training mit fester Länge statt Early Stopping: der Eval-Loss steigt bei
// einem Buch-LoRA schon nach einem Drittel der ersten Epoche, während das
// Faktenwissen noch wächst — Early Stopping behielte den Stand, der Fakten
// am schlechtesten kennt. Stattdessen Stände im Abstand von ~10 % sichern
// und gegen eval.jsonl vergleichen (docs/finetuning.md §5).
const TRAINING_BASE = {
  max_steps: 0,
  num_epochs: 1,
  learning_rate: 1e-4,
  lr_scheduler_type: 'cosine',
  warmup_steps: 20,
  weight_decay: 0.01,
  optim: 'adamw_8bit',
  packing: false,
  // Studio liest eval_steps als Anteil der Gesamtschritte (0–1), nicht als Zahl.
  eval_steps: 0.1,
  early_stopping_patience: 0,
  save_steps: 100,
  train_on_completions: true,
  random_seed: 42,
  gradient_checkpointing: 'unsloth',
};

const LORA_BASE = {
  lora_dropout: 0.05,
  target_modules: ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'],
  // Beide Basismodelle tragen einen Pixtral-Vision-Encoder; ohne Bilddaten
  // bleibt er eingefroren.
  finetune_vision_layers: false,
  finetune_language_layers: true,
  finetune_attention_modules: true,
  finetune_mlp_modules: true,
  use_rslora: false,
  use_loftq: false,
  use_dora: false,
};

const LOGGING = {
  enable_tensorboard: true,
  tensorboard_dir: 'runs',
  log_frequency: 20,
  enable_wandb: false,
};

// Trainingslänge: `epochs` (num_epochs = trainEpochs) oder `steps`
// (max_steps ≈ trainEpochs Epochen, braucht die Train-Grösse des Exports).
const TRAIN_LENGTH = { trainBy: 'epochs', trainEpochs: 1 };
// Gesicherte Stände: so viele über den ganzen Lauf verteilt.
const SAVE_FRACTION = 0.1;

// Export-Vorgaben (routes/jobs/finetune-export, docs/finetuning.md §2). Ein
// Profil kann einzelne Werte über `export` überschreiben. Der Server liest
// dieselbe Quelle (lib/esm-bridge.js), die Karte schickt sie mit.
export const EXPORT_DEFAULTS = {
  // Kernwissen (samples/core-facts/): Figuren ab so vielen Erwähnungen im
  // Text bekommen figureCore/figureAttr/relationCore; jeder Kernfakt in
  // `factParaphrases` Varianten (Frage UND Antwort verschieden), höchstens
  // `maxVariantsPerFact`.
  minMentions: 5,
  factParaphrases: 4,
  maxVariantsPerFact: 5,
  // Mischung nach Antwort-Tokens (lib/token-mix.js); refusal nach Anzahl.
  familyTokenShares: { writing: 0.55, facts: 0.30, persona: 0.10, refusal: 0.05 },
  refusalShare: 0.03,
  refusalMix: { unknownEntity: 0.5, offTopic: 0.25, falsePremise: 0.25 },
  verbatimMaxTokenShare: 0.01,
  // Längste Antwort pro Aufgabentyp, gekürzt an Satzgrenzen.
  maxAnswerChars: { sceneWrite: 2000, povPassage: 2000, passage: 2000, continue: 1500 },
  // Höchstens so viele Samples mit demselben Absatz als Ziel.
  maxTargetsPerParagraph: 2,
  // «Wer sagt das?» nur für Zitate ab so vielen Wörtern.
  whoSaysMinWords: 6,
  // Lektorats-Feedback als eigener Aufgabentyp (Werkstattwissen, Standard aus).
  editorFeedback: false,
  // Varianten der Kernfakten zusätzlich per KI umformulieren (geprüft gegen die Quelle).
  aiParaphrase: false,
  // Typen, die standardmässig aus sind.
  types: { verbatim: false },
};

const isPlainObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
function mergeDeep(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    out[k] = isPlainObj(v) && isPlainObj(base[k]) ? mergeDeep(base[k], v) : v;
  }
  return out;
}

/** Export-Vorgaben eines Profils: EXPORT_DEFAULTS + Profil-Overrides. */
export function exportOptions(profile) {
  return mergeDeep(EXPORT_DEFAULTS, profile?.export);
}

const MINISTRAL_8B = { name: 'Ministral 3 8B', model: 'unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit' };
const MISTRAL_SMALL_24B = { name: 'Mistral Small 3.2 24B', model: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit' };

// `maxChars` hält p95 der Samples deutlich unter dem Sequenz-Budget
// (4000 Zeichen ≈ 1500 Tokens bei seq 4096).
export const FINETUNE_PROFILES = [
  { id: 'ministral3-8b-16gb', ...MINISTRAL_8B, ...TRAIN_LENGTH, vramGb: 16, batch: 1, accum: 16, seq: 4096, r: 32, maxChars: 4000 },
  { id: 'ministral3-8b-20gb', ...MINISTRAL_8B, ...TRAIN_LENGTH, vramGb: 20, batch: 2, accum: 8, seq: 4096, r: 32, maxChars: 4000 },
  { id: 'ministral3-8b-24gb', ...MINISTRAL_8B, ...TRAIN_LENGTH, vramGb: 24, batch: 2, accum: 8, seq: 8192, r: 64, maxChars: 8000 },
  { id: 'mistral-small32-24b-20gb', ...MISTRAL_SMALL_24B, ...TRAIN_LENGTH, vramGb: 20, batch: 1, accum: 16, seq: 4096, r: 32, maxChars: 4000 },
];

export const DEFAULT_FINETUNE_PROFILE_ID = 'ministral3-8b-20gb';

export function finetuneProfileById(id) {
  return FINETUNE_PROFILES.find(p => p.id === id)
    || FINETUNE_PROFILES.find(p => p.id === DEFAULT_FINETUNE_PROFILE_ID);
}

/**
 * Schritte eines Laufs: `perEpoch` = ceil(train / (batch × accum)), `total` =
 * perEpoch × Epochen (bzw. max_steps). null ohne Train-Grösse.
 */
export function studioSteps(profile, trainCount) {
  if (!(trainCount > 0)) return null;
  const perEpoch = Math.ceil(trainCount / (profile.batch * profile.accum));
  const epochs = profile.trainEpochs || 1;
  const total = Math.ceil(perEpoch * epochs);
  return { perEpoch, epochs, total, save: Math.max(1, Math.round(total * SAVE_FRACTION)) };
}

/**
 * Studio-Konfiguration als Objekt; `maxSeqTokens` (> 0) folgt dem Export der
 * Karte, `trainCount` (Train-Samples des Exports) bestimmt save_steps und —
 * bei `trainBy: 'steps'` — max_steps. Ohne Export gelten die Basiswerte.
 */
export function studioConfig(profile, { maxSeqTokens, trainCount } = {}) {
  const steps = studioSteps(profile, trainCount);
  const length = profile.trainBy === 'steps' && steps
    ? { max_steps: steps.total }
    : { num_epochs: profile.trainEpochs || TRAINING_BASE.num_epochs };
  return {
    training: {
      ...TRAINING_BASE,
      ...length,
      ...(steps ? { save_steps: steps.save } : {}),
      max_seq_length: maxSeqTokens > 0 ? maxSeqTokens : profile.seq,
      batch_size: profile.batch,
      gradient_accumulation_steps: profile.accum,
    },
    lora: { ...LORA_BASE, lora_r: profile.r, lora_alpha: profile.r },
    logging: { ...LOGGING },
  };
}

const yamlScalar = (v) => (typeof v === 'string' ? v : String(v));

/**
 * YAML-Text für Studios „Training Config → Upload". `header` sind fertig
 * übersetzte Kommentarzeilen (ohne `#`).
 */
export function buildStudioYaml(profile, { maxSeqTokens, trainCount, header = [] } = {}) {
  const cfg = studioConfig(profile, { maxSeqTokens, trainCount });
  const lines = header.map(h => `# ${h}`);
  if (lines.length) lines.push('');
  for (const [section, fields] of Object.entries(cfg)) {
    lines.push(`${section}:`);
    for (const [key, value] of Object.entries(fields)) {
      if (Array.isArray(value)) {
        lines.push(`  ${key}:`);
        for (const item of value) lines.push(`    - ${yamlScalar(item)}`);
      } else {
        lines.push(`  ${key}: ${yamlScalar(value)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}
