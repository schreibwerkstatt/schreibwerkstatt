// Vertrag der Fokus-Hervorhebung mit den nativen Clients — Chromium.
// Testkörper und Begründung: _helpers/focus-client-contract.js. WebKit (Engine
// des macOS-Clients): focus-client-contract.webkit.spec.js.

const { registerFocusClientContract } = require('./_helpers/focus-client-contract');

registerFocusClientContract();
