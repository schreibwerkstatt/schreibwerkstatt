// iOS/iPadOS: kein Auto-Zoom beim Fokus eines Eingabefelds.
//
// Safari zoomt die Seite hinein, sobald ein Feld mit font-size < 16px den
// Fokus bekommt — auch auf dem iPad, wo die App bewusst die dichte Desktop-
// Schrift (12–14px) zeigt. Danach steht die Ansicht verschoben, verankerte
// Popover (Combobox, Picker) liegen neben ihrem Trigger, und der User muss
// zurückzoomen. Die 16px-Schutzregeln in den CSS-Dateien greifen nur auf
// schmalen Viewports (Phone-Layout), nicht auf dem iPad.
//
// `maximum-scale=1` unterdrückt genau diesen Auto-Zoom. Seit iOS 10 ignoriert
// Safari die Angabe für das Pinch-Zoom des Users — die Seite bleibt also
// zoombar (Barrierefreiheit). Andere Browser (Android Chrome) sperrten damit
// das Pinch-Zoom; darum nur auf iOS/iPadOS setzen. iPadOS meldet sich als
// «MacIntel», unterscheidet sich vom Mac aber durch Touch-Punkte.
//
// Klassisches Script vor dem ersten Paint (index.html, share.html), damit die
// Viewport-Angabe steht, bevor das erste Feld fokussiert werden kann.
(function () {
  if (typeof navigator === 'undefined' || typeof document === 'undefined') return;
  var ua = navigator.userAgent || '';
  var isIOS = /iPad|iPhone|iPod/.test(ua)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (!isIOS) return;
  var meta = document.querySelector('meta[name="viewport"]');
  if (!meta) return;
  var content = meta.getAttribute('content') || '';
  if (/maximum-scale/.test(content)) return;
  meta.setAttribute('content', content + ', maximum-scale=1');
})();
