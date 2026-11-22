// Pure Avatar-Primitive für die Initialen-Pips (Google-Docs-Optik): eine
// deterministische Hue pro Person + Initialen aus dem Anzeigenamen. SSoT für die
// SPA (presence-pips via app.userAvatarHue, Kommentar-Leisten via
// comment-rail-core) und die standalone Share-Reader-Leiste — gleiche Person →
// gleiche Pip-Farbe in Reader und SPA. Keine DOM-/Framework-Abhängigkeit.

// Stabiler Farbton [0..359] aus einem Seed (Email bzw. Anzeigename). Leerer/
// fehlender Seed → 0.
export function avatarHue(seed) {
  const s = String(seed || '').toLowerCase();
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

// Bis zu zwei Initialen aus einem Anzeigenamen. Getrennt wird an allem, was
// weder Buchstabe noch Ziffer ist (Whitespace, ._@-, Klammern …) — sonst wird aus
// «Dev (lokal)» das Kürzel «D(». Ohne Buchstabe/Ziffer → '?'.
export function avatarInitials(label) {
  const tokens = String(label == null ? '' : label).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (!tokens.length) return '?';
  return ((tokens[0][0] || '') + (tokens.length > 1 ? (tokens[1][0] || '') : '')).toUpperCase().slice(0, 2);
}
