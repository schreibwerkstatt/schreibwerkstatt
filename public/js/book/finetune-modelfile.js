// Ollama-Modelfile für ein auf dem Fine-Tuning-Export trainiertes Modell.
//
// Pure Daten + Generator ohne Alpine, damit der Drift-Test gegen
// docs/unsloth-config/Modelfile.example sie direkt lädt. Der System-Prompt
// kommt aus dem gespeicherten Export (stats.systemPrompt, gesetzt vom Job) —
// wörtlich derselbe wie im Training, sonst verliert das Modell die Persona.
//
// Template: Mistral-Tekken (Ministral 3, Mistral Small 3.2) über `.Messages`,
// damit ein Verlauf mit mehreren Runden so aussieht wie im Training. Kein
// literales `<s>`: llama.cpp setzt BOS beim Tokenisieren selbst
// (add_bos_token), ein zweites hiesse <s><s> — dieselbe Falle, die
// train_book.py beim Rendern umgeht.

// ChatML (Qwen): `<|im_start|>role … <|im_end|>`, Stopp am Ende jedes Zugs.
export const MODELFILE_TEMPLATE_CHATML = [
  '{{- range $i, $_ := .Messages }}',
  '<|im_start|>{{ .Role }}',
  '{{ .Content }}<|im_end|>',
  '{{ end }}<|im_start|>assistant',
  '',
].join('\n');

export const MODELFILE_TEMPLATE = [
  '{{- range $i, $_ := .Messages }}',
  '{{- if eq .Role "system" }}[SYSTEM_PROMPT]{{ .Content }}[/SYSTEM_PROMPT]',
  '{{- else if eq .Role "user" }}[INST]{{ .Content }}[/INST]',
  '{{- else if eq .Role "assistant" }}{{ .Content }}</s>',
  '{{- end }}',
  '{{- end }}',
].join('\n');

// 0.5: Mitte des Fensters für Faktenwiedergabe (docs/finetuning.md §4) — das
// Leser-Modell antwortet ohne Nachschlagen, und Faktenfragen erfinden bei
// höherer Temperatur mehr. repeat_penalty 1.15 über die letzten 256 Tokens
// gegen die Schleifen, die ein Buch-LoRA zeigt («Die erste Begegnung …» fünfmal,
// «Er wollte … Er wollte …»); 1.1 über das Ollama-Standardfenster von 64 Tokens
// liess sie bei Kapitelanfängen durch. Studio-Inferenz und Ollama setzen das
// sonst nicht — darum steht es hier. 32k Kontext reicht für Gespräche und spart
// KV-Cache gegenüber den nativen 256k.
export const MODELFILE_PARAMS = [
  ['temperature', '0.5'],
  ['top_p', '0.95'],
  ['repeat_penalty', '1.15'],
  ['repeat_last_n', '256'],
  ['num_ctx', '32768'],
];

export const MODELFILE_FROM = './unsloth.Q5_K_M.gguf';

/**
 * Modelfile-Text. `header` sind fertig übersetzte Kommentarzeilen (ohne `#`),
 * `chatTemplate` aus dem Profil (finetune-profiles.js): 'mistral' (Default) oder 'chatml'.
 */
export function buildModelfile({ systemPrompt, header = [], chatTemplate = 'mistral' }) {
  const chatml = chatTemplate === 'chatml';
  const lines = header.map(h => `# ${h}`);
  if (lines.length) lines.push('');
  lines.push(`FROM ${MODELFILE_FROM}`, '');
  lines.push(`TEMPLATE """${chatml ? MODELFILE_TEMPLATE_CHATML : MODELFILE_TEMPLATE}"""`, '');
  for (const [k, v] of MODELFILE_PARAMS) lines.push(`PARAMETER ${k} ${v}`);
  if (chatml) lines.push('PARAMETER stop "<|im_end|>"');
  lines.push('', `SYSTEM """${String(systemPrompt || '').replace(/"""/g, '"')}"""`);
  return lines.join('\n') + '\n';
}
