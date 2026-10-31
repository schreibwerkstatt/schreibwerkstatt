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

export const MODELFILE_TEMPLATE = [
  '{{- range $i, $_ := .Messages }}',
  '{{- if eq .Role "system" }}[SYSTEM_PROMPT]{{ .Content }}[/SYSTEM_PROMPT]',
  '{{- else if eq .Role "user" }}[INST]{{ .Content }}[/INST]',
  '{{- else if eq .Role "assistant" }}{{ .Content }}</s>',
  '{{- end }}',
  '{{- end }}',
].join('\n');

// Prosa im Buchstil: 0.7–0.85 (docs/finetuning.md §4). 32k Kontext reicht für
// Gespräche und spart KV-Cache gegenüber den nativen 256k.
export const MODELFILE_PARAMS = [
  ['temperature', '0.8'],
  ['top_p', '0.95'],
  ['repeat_penalty', '1.05'],
  ['num_ctx', '32768'],
];

export const MODELFILE_FROM = './unsloth.Q5_K_M.gguf';

/**
 * Modelfile-Text. `header` sind fertig übersetzte Kommentarzeilen (ohne `#`).
 */
export function buildModelfile({ systemPrompt, header = [] }) {
  const lines = header.map(h => `# ${h}`);
  if (lines.length) lines.push('');
  lines.push(`FROM ${MODELFILE_FROM}`, '');
  lines.push(`TEMPLATE """${MODELFILE_TEMPLATE}"""`, '');
  for (const [k, v] of MODELFILE_PARAMS) lines.push(`PARAMETER ${k} ${v}`);
  lines.push('', `SYSTEM """${String(systemPrompt || '').replace(/"""/g, '"')}"""`);
  return lines.join('\n') + '\n';
}
