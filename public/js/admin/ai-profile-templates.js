// Vorlagen für KI-Profile (Provider-Tab, Sub-Tab «Profile»): erprobte Belegungen
// für ein Modell, die beim Anlegen das Formular füllen. Eine Vorlage ist ein
// Startpunkt, keine Verknüpfung — gespeichert wird das Formular, ein späterer
// Wechsel hier ändert bestehende Profile nicht.
//
// Host und API-Key stehen bewusst NIE in einer Vorlage: sie gehören zur
// Installation (welcher LiteLLM, welcher Schlüssel), nicht zum Modell. Leer
// gelassen übernimmt das Profil die Instanz-Einstellung des Provider-Sub-Tabs.
// Formularwerte in der Form von adminAiProfilesMethods (dreiwertige Felder als
// String: '' = global, 'true'/'false' = gesetzt). Label und Notiz als i18n-Key.

export const AI_PROFILE_TEMPLATES = [
  {
    // Qwen 3.8 27B über den LiteLLM-Alias `qwen3.8-27b-think` (LocalAI dahinter).
    // Gemessen 2026-11-16: ohne Thinking liefen lange Lektorat-Abschnitte in eine
    // Ausgabeschleife bis zum Output-Deckel; mit Thinking und vollen Prompts
    // (Cloud-Klasse) im Gold-Set Recall 88 % statt 52 %, Typ richtig 97 % statt 32 %.
    // Zwei parallele Calls: 84 statt 45 Tok/s Gesamtdurchsatz. Fenster 196608 statt
    // 262144: die Längenprüfung von LiteLLM zählt strenger als der Qwen-Tokenizer.
    // Dazu gehört global `ai.openai-compat.reasoning_budget.lektorat` = 4000 (kein
    // Profilfeld) — die Notiz nennt es.
    id: 'qwen38-27b-think-litellm',
    label: 'admin.profiles.template.qwen38Think.label',
    notes: 'admin.profiles.template.qwen38Think.notes',
    form: {
      provider: 'openai-compat',
      model: 'qwen3.8-27b-think',
      cloud: 'true',
      think: 'true',
      max_parallel: 2,
      context_window: 196608,
      max_tokens_out: 32768,
    },
  },
];

export function aiProfileTemplate(id) {
  return AI_PROFILE_TEMPLATES.find(t => t.id === id) || null;
}
