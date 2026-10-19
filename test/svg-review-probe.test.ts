import { test } from 'node:test';
import { chromium } from 'playwright';
import { runAxe, stateContrast } from '../src/checks.ts';

const cases: Record<string,string> = {
  rotated: '<text id="label" x="50" y="65" transform="rotate(15 50 65)" fill="#ddd">Rotated label</text>',
  skewed: '<text id="label" x="30" y="55" transform="skewX(15)" fill="#ddd">Skewed label</text>',
  spacing: '<rect x="0" width="130" height="100" fill="black"/><text id="label" x="10" y="55" fill="white" letter-spacing="12">Spaced label</text>',
  groupOpacity: '<g id="faded" opacity=".2"><text id="label" x="30" y="55">Faded label</text></g>',
  fillOpacity: '<text id="label" x="30" y="55" fill="black" fill-opacity=".2">Faint label</text>',
  textPaintOrder: '<text id="label" x="30" y="55" fill="white" stroke="black" stroke-width="8" paint-order="stroke fill">Outlined label</text>',
  gradient: '<defs><linearGradient id="g"><stop stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient></defs><rect id="gradient" width="400" height="200" fill="url(#g)"/><text id="label" x="30" y="55">Gradient label</text>',
  image: '<image id="picture" width="400" height="200" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27400%27 height=%27200%27%3E%3Crect width=%27400%27 height=%27200%27 fill=%27black%27/%3E%3C/svg%3E"/><text id="label" x="30" y="55">Image label</text>',
  clipped: '<text id="label" x="330" y="55" fill="#ddd">Partly outside the viewport</text>',
  ariaBackdrop: '<rect id="panel" aria-hidden="true" width="400" height="200" fill="black"/><text id="label" x="30" y="55">Black on black</text>',
  ariaGroupBackdrop: '<g aria-hidden="true"><rect id="panel" width="400" height="200" fill="black"/></g><text id="label" x="30" y="55">Black on black</text>',
  ariaLaterOverlay: '<text id="label" x="30" y="55">Hidden by paint</text><rect aria-hidden="true" width="400" height="200" fill="white" opacity=".8"/>',
  ownOpacity: '<text id="label" x="30" y="55" opacity=".2">Faint label</text>',
  rotatedGlyphs: '<text id="label" x="30" y="75" rotate="90" fill="#ddd">Rotated glyphs</text>',
  zeroLengthRoundBackdrop: '<line id="dot" x1="50" y1="50" x2="50" y2="50" stroke="black" stroke-width="100" stroke-linecap="round"/><text id="label" x="30" y="55">Dot label</text>',
  laterText: '<text id="label" x="30" y="55">Covered label</text><text x="30" y="55" fill="white">Covered label</text>',
  strokedInvisibleBackdrop: '<rect id="panel" width="400" height="200" fill="none" stroke="black" stroke-width="400"/><text id="label" x="30" y="55">Black on black</text>',
  nestedViewport: '<svg x="10" y="10" width="300" height="100" viewBox="0 0 600 200"><text id="label" x="30" y="55" style="font-size:40px" fill="#888">Scaled nested</text></svg>',
  disjointImage: '<image id="picture" x="350" y="150" width="10" height="10" href="data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27/%3E"/><text id="label" x="30" y="55">Unrelated image</text>',
};

test('independent SVG review probes', async (t) => {
  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    for (const [name, content] of Object.entries(cases)) {
      await page.setContent(`<!doctype html><html lang="en"><head><title>Probe</title><style>body{background:white;color:#111}text{font:16px Arial,sans-serif}</style></head><body><main><h1>Probe</h1><svg width="400" height="200" role="img" aria-label="Probe">${content}</svg></main></body></html>`);
      await page.evaluate(() => document.fonts.ready.then(()=>{}));
      const result = await runAxe(page,'probe.html');
      t.diagnostic(JSON.stringify({name,findings:result.findings.filter(x=>x.rule==='svg-text-contrast'),reviews:result.needsReview?.filter(x=>x.rule==='svg-text-contrast'),evaluations:result.evaluations?.filter(x=>x.rule==='svg-text-contrast')}));
    }
  } finally { await context.close(); await browser.close(); }
});
