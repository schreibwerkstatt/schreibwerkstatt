'use strict';
// Regex-Sonderzeichen eines Literals escapen, damit es wörtlich in ein RegExp passt.
// Einziger Ort dafür im Server-Code.

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { escapeRegex };
