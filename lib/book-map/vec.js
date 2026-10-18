'use strict';
// Vektor-Helfer der Buchlandkarte (lib/book-map.js und Geschwister). Alle Punkte
// der Karte sind Einheitsvektoren — darum ist `dot` hier der Cosinus.

// Vektor auf Einheitslänge; null bei Nullvektor.
function unit(v) {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  if (!(norm > 0)) return null;
  const inv = 1 / Math.sqrt(norm);
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] * inv;
  return out;
}

// Skalarprodukt. Auf Einheitsvektoren IST das der Cosinus — die Normierung in
// `preparePoints`/`unit` ist die Voraussetzung dafür, dass hier keine Norm mehr
// pro Paar gerechnet werden muss.
function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

// Cosinus eines Einheitsvektors `u` zu einem beliebigen Vektor `v`; 0, wenn
// `v` der Nullvektor ist (keine Richtung → keine Ähnlichkeit).
function cosToRaw(u, v) {
  let d = 0;
  let norm = 0;
  for (let i = 0; i < v.length; i++) { d += u[i] * v[i]; norm += v[i] * v[i]; }
  return norm > 0 ? d / Math.sqrt(norm) : 0;
}

function sumVectors(points, dim) {
  const sum = new Float64Array(dim);
  for (const p of points) for (let i = 0; i < dim; i++) sum[i] += p.vector[i];
  return sum;
}

function median(values) {
  const s = [...values].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

module.exports = { unit, dot, cosToRaw, sumVectors, median };
