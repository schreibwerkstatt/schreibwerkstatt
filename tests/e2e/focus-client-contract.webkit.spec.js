// Vertrag der Fokus-Hervorhebung mit den nativen Clients — WebKit, die Engine
// des macOS-Clients (WKWebView). Dieselben Testkörper wie die Chromium-Spec
// (_helpers/focus-client-contract.js): Opacity-Kaskade, Custom Highlight API und
// Caret-Geometrie sind genau die Stellen, an denen sich die Engines unterscheiden.

const { registerFocusClientContract } = require('./_helpers/focus-client-contract');

registerFocusClientContract();
