'use strict';
// Re-Export der Facade aus dem agentic-chat/-Subfolder (Loop in loop.js, Verlauf
// in history.js, Hilfen in helpers.js). Konsumenten importieren weiterhin
// `./agentic-chat`; Node löst die Datei vor dem gleichnamigen Ordner auf.

module.exports = require('./agentic-chat/index');
