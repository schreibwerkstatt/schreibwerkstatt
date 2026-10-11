'use strict';
// Content-Block-Reducer des Claude-Tool-Pfads (lib/ai/claude.js#_callClaudeWithToolsAttempt).
// Ausgelagert, damit Stream-Ereignisse ohne Netz unit-testbar sind.
//
// Die Blöcke einer Antwort werden per Index adressiert (content_block_start/delta/
// stop) und gehen als `rawContentBlocks` unverändert in die nächste Runde zurück.
// «Unverändert» ist dabei Vertrag, nicht Kosmetik: Thinking-Blöcke sind an den
// Gesprächsanfang gebunden, den das Modell sah (preserved thinking), und ein
// Server-Werkzeug-Ergebnis gehört zu seinem `server_tool_use`. Unbekannte Blocktypen
// (neue Server-Werkzeuge, `fallback`-Marker) werden darum verbatim mitgeführt statt
// verworfen.

// content_block_start → Akkumulator-Eintrag.
function startBlock(cb) {
  if (!cb || typeof cb.type !== 'string') return null;
  if (cb.type === 'tool_use') return { type: 'tool_use', id: cb.id, name: cb.name, _inputJson: '' };
  // Server-Werkzeug (web_search): Input kommt wie bei tool_use per input_json_delta;
  // Anthropic führt es selbst aus, der Block gehört aber zur Assistant-Runde.
  if (cb.type === 'server_tool_use') return { type: 'server_tool_use', id: cb.id, name: cb.name, _inputJson: '' };
  // Server-Werkzeug-Ergebnis: kommt vollständig im content_block_start.
  if (cb.type === 'web_search_tool_result') return { type: 'web_search_tool_result', tool_use_id: cb.tool_use_id, content: cb.content };
  if (cb.type === 'text') return { type: 'text', text: '' };
  // Adaptive Thinking: Block samt `signature` MUSS in der nächsten Runde zurück.
  // Unter display 'omitted' bleibt `thinking` leer, unter 'summarized' trägt er eine
  // Zusammenfassung — die signature kommt in beiden Fällen per signature_delta.
  if (cb.type === 'thinking') return { type: 'thinking', thinking: cb.thinking || '', signature: cb.signature || '' };
  if (cb.type === 'redacted_thinking') return { type: 'redacted_thinking', data: cb.data || '' };
  return { type: cb.type, _raw: { ...cb } };
}

// content_block_delta auf einen Block anwenden. Liefert die Zahl der neuen
// Output-Zeichen (für die Live-Anzeige) und den Textanteil.
function applyDelta(b, d) {
  if (!b || !d) return { chars: 0, text: '' };
  if (d.type === 'text_delta') {
    const t = d.text || '';
    if (b._raw) b._raw.text = (b._raw.text || '') + t;
    else b.text = (b.text || '') + t;
    return { chars: t.length, text: b.type === 'text' ? t : '' };
  }
  if (d.type === 'input_json_delta') {
    const p = d.partial_json || '';
    b._inputJson = (b._inputJson || '') + p;
    return { chars: p.length, text: '' };
  }
  if (d.type === 'thinking_delta') {
    b.thinking = (b.thinking || '') + (d.thinking || '');
  } else if (d.type === 'signature_delta') {
    b.signature = (b.signature || '') + (d.signature || '');
  }
  return { chars: 0, text: '' };
}

// content_block_stop: akkumuliertes Input-JSON parsen (strikt — ein kaputtes oder
// abgeschnittenes Argument wird `parseError`, nie ein still gekürztes Objekt).
function stopBlock(b) {
  if (!b || b._inputJson == null) return;
  const target = b._raw || b;
  try { target.input = b._inputJson ? JSON.parse(b._inputJson) : (target.input || {}); }
  catch (e) { target.input = {}; b.parseError = e.message; }
  delete b._inputJson;
}

function _serialize(b) {
  if (b._raw) return b._raw;
  if (b.type === 'thinking') return { type: 'thinking', thinking: b.thinking, signature: b.signature };
  if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data };
  if (b.type === 'text') return { type: 'text', text: b.text };
  if (b.type === 'server_tool_use') return { type: 'server_tool_use', id: b.id, name: b.name, input: b.input || {} };
  if (b.type === 'web_search_tool_result') return { type: 'web_search_tool_result', tool_use_id: b.tool_use_id, content: b.content };
  return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
}

// Nach einem Modellwechsel mitten in der Antwort (Refusal-Fallback) markiert ein
// `fallback`-Block die Grenze. Vor der LETZTEN Grenze gehören Thinking, tool_use,
// unvollständige Server-Werkzeug-Paare und unbekannte Modell-Blöcke zum abgelehnten
// Versuch: sie werden weder ausgeführt noch zurückgespielt. Text und vollständige
// Server-Werkzeug-Paare bleiben, ebenso der Marker selbst.
function _dropBeforeFallback(list) {
  let boundary = -1;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].type === 'fallback') { boundary = i; break; }
  if (boundary < 0) return { kept: list, boundary: -1 };
  const resultIds = new Set(list.slice(0, boundary).map(b => b.tool_use_id).filter(Boolean));
  const useIds = new Set(list.slice(0, boundary).filter(b => b.type === 'server_tool_use').map(b => b.id));
  const kept = list.filter((b, i) => {
    if (i >= boundary) return true;
    if (b.type === 'text' || b.type === 'fallback') return true;
    if (b.type === 'server_tool_use') return resultIds.has(b.id);
    if (b.tool_use_id && /_tool_result$/.test(b.type)) return useIds.has(b.tool_use_id);
    return false;
  });
  return { kept, boundary: kept.findIndex(b => b.type === 'fallback' && b === list[boundary]) };
}

// Abschluss: ausführbare tool_uses + Blöcke für die nächste Runde.
function finalizeBlocks(blocks) {
  const list = blocks.filter(Boolean);
  const { kept, boundary } = _dropBeforeFallback(list);
  const toolUses = kept
    .filter((b, i) => b.type === 'tool_use' && !b._raw && i > boundary)
    .map(b => ({ id: b.id, name: b.name, input: b.input || {}, ...(b.parseError ? { parseError: b.parseError } : {}) }));
  return { toolUses, rawContentBlocks: kept.map(_serialize), fellBack: boundary >= 0 };
}

// Letzte Zeile einer Thinking-Zusammenfassung als kurzer Zwischenstand fürs UI.
const NOTE_MAX = 160;
function progressNote(thinking) {
  const lines = String(thinking || '').split('\n').map(s => s.replace(/^[#*\-\s]+/, '').trim()).filter(Boolean);
  const last = lines.at(-1) || '';
  return last.length > NOTE_MAX ? last.slice(0, NOTE_MAX - 1) + '…' : last;
}

module.exports = { startBlock, applyDelta, stopBlock, finalizeBlocks, progressNote };
