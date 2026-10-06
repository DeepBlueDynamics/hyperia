// Toast layer page entry: render what main sends, report our size so main can
// shrink-wrap the native view around the content.
'use strict';

(function bootToastLayer() {
  const api = window.hyToastLayer;
  const R = window.HyToastRender;
  const root = document.getElementById('root');
  if (!api || !R || !root) return;

  let lastW = -1;
  let lastH = -1;
  let count = 0;
  const report = () => {
    // Nothing up: the padded empty root still has a size, and main must not
    // keep a view around for it.
    const rect = count > 0 ? root.getBoundingClientRect() : {width: 0, height: 0};
    const w = Math.ceil(rect.width);
    const h = Math.ceil(rect.height);
    if (w === lastW && h === lastH) return;
    lastW = w;
    lastH = h;
    api.reportSize(w, h);
  };

  api.onRender((payload) => {
    R.applyTheme(document, payload && payload.theme);
    root.setAttribute('data-anchor', (payload && payload.anchor) === 'bottom-right' ? 'bottom-right' : 'top');
    count = R.render(document, root, payload && payload.items, (toastId, buttonId) => api.action(toastId, buttonId));
    // Measure NOW: getBoundingClientRect forces layout even while the view is
    // hidden, whereas rAF and ResizeObserver only run once it paints — and
    // main keeps the view hidden until it has a size (chicken-and-egg). The
    // observer + a short re-measure still catch late reflows (fonts, wrapping).
    report();
    setTimeout(report, 80);
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(report).observe(root);
})();
