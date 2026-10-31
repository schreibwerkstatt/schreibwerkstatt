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
const TRAINING_BASE = {
  max_steps: 0,
  num_epochs: 2,
  learning_rate: 2e-4,
  lr_scheduler_type: 'cosine',
  warmup_steps: 20,
  weight_decay: 0.01,
  optim: 'adamw_8bit',
  packing: false,
  eval_steps: 200,
  early_stopping_patience: 3,
  save_steps: 400,
  train_on_completions: true,
  random_seed: 42,
  gradient_checkpointing: 'unsloth',
};

const LORA_BASE = {
  lora_dropout: 0,
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

const MINISTRAL_8B = { name: 'Ministral 3 8B', model: 'unsloth/Ministral-3-8B-Instruct-2512-unsloth-bnb-4bit' };
const MISTRAL_SMALL_24B = { name: 'Mistral Small 3.2 24B', model: 'unsloth/Mistral-Small-3.2-24B-Instruct-2506-unsloth-bnb-4bit' };

// `maxChars` hält p95 der Samples deutlich unter dem Sequenz-Budget
// (4000 Zeichen ≈ 1500 Tokens bei seq 4096).
export const FINETUNE_PROFILES = [
  { id: 'ministral3-8b-16gb', ...MINISTRAL_8B, vramGb: 16, batch: 1, accum: 16, seq: 4096, r: 32, maxChars: 4000 },
  { id: 'ministral3-8b-20gb', ...MINISTRAL_8B, vramGb: 20, batch: 2, accum: 8, seq: 4096, r: 32, maxChars: 4000 },
  { id: 'ministral3-8b-24gb', ...MINISTRAL_8B, vramGb: 24, batch: 2, accum: 8, seq: 8192, r: 64, maxChars: 8000 },
  { id: 'mistral-small32-24b-20gb', ...MISTRAL_SMALL_24B, vramGb: 20, batch: 1, accum: 16, seq: 4096, r: 32, maxChars: 4000 },
];

export const DEFAULT_FINETUNE_PROFILE_ID = 'ministral3-8b-20gb';

export function finetuneProfileById(id) {
  return FINETUNE_PROFILES.find(p => p.id === id)
    || FINETUNE_PROFILES.find(p => p.id === DEFAULT_FINETUNE_PROFILE_ID);
}

/** Studio-Konfiguration als Objekt; `maxSeqTokens` (> 0) folgt dem Export der Karte. */
export function studioConfig(profile, { maxSeqTokens } = {}) {
  return {
    training: {
      ...TRAINING_BASE,
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
export function buildStudioYaml(profile, { maxSeqTokens, header = [] } = {}) {
  const cfg = studioConfig(profile, { maxSeqTokens });
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
