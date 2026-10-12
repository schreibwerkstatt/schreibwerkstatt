'use strict';
// Nachrichtenverlauf-Block der PDF-Export-Profile (div.msg-thread, Markup-SSoT
// public/js/messages/msg-html.js): Defaults + Validator. Ein Konsument:
// lib/pdf-render/block-messages.js.
//
// `style`: 'plain' setzt den Verlauf typografisch — eingehend links, ausgehend
//   rechtsbündig, Absender klein und fett darüber, Zeitangaben zentriert. Das
//   ist die Buchkonvention und die Vorgabe. 'bubbles' legt hinter jede
//   Nachricht eine leichte graue Fläche mit runden Ecken (Handy-Anmutung).

const { isObj, enumOf } = require('./coerce');

const MSG_STYLES = ['plain', 'bubbles'];

const DEFAULT_MESSAGES = {
  style: 'plain',
};

function validateMessages(src) {
  const d = DEFAULT_MESSAGES;
  if (!isObj(src)) return { ...d };
  return {
    style: enumOf(src.style, MSG_STYLES, d.style),
  };
}

module.exports = { DEFAULT_MESSAGES, validateMessages, MSG_STYLES };
