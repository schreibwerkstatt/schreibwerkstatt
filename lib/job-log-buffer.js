'use strict';
// Ring-Buffer pro Job-ID. Winston-printf pusht jede Log-Zeile mit gesetztem
// jobId; failJob/completeJob holen den Snapshot fuer Admin-Notification-Mails
// und entsorgen den Eintrag. Bound: MAX_LINES pro Job * MAX_LINE_LEN.
//
// Gepuffert wird nur fuer GEOEFFNETE Jobs (`open` in createJob, `clear` am
// Terminal-Status). Eine Log-Zeile mit der jobId eines bereits beendeten Jobs —
// z.B. aus einem Fire-and-forget-Nachlauf nach completeJob, der den ALS-Context
// erbt — legt KEINEN neuen Eintrag an, den niemand mehr raeumt. Zusaetzlich
// deckelt MAX_OPEN die Zahl offener Puffer (aelteste fliegen zuerst), falls ein
// Job nie terminal verbucht wird.

const MAX_LINES = 300;
const MAX_LINE_LEN = 500;
const MAX_SNAPSHOT_CHARS = 8000;
const MAX_OPEN = 500;

const _buffers = new Map();

function open(jobId) {
  if (!jobId || _buffers.has(jobId)) return;
  _buffers.set(jobId, []);
  while (_buffers.size > MAX_OPEN) {
    _buffers.delete(_buffers.keys().next().value);
  }
}

function append(jobId, line) {
  if (!jobId || !line) return;
  const arr = _buffers.get(jobId);
  if (!arr) return;
  const trimmed = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + '…' : line;
  arr.push(trimmed);
  if (arr.length > MAX_LINES) arr.splice(0, arr.length - MAX_LINES);
}

function snapshot(jobId) {
  const arr = _buffers.get(jobId);
  if (!arr || !arr.length) return '';
  let out = arr.join('\n');
  if (out.length > MAX_SNAPSHOT_CHARS) out = '…\n' + out.slice(out.length - MAX_SNAPSHOT_CHARS);
  return out;
}

function clear(jobId) {
  if (!jobId) return;
  _buffers.delete(jobId);
}

function size() { return _buffers.size; }

module.exports = { open, append, snapshot, clear, size, MAX_LINES, MAX_LINE_LEN, MAX_SNAPSHOT_CHARS, MAX_OPEN };
