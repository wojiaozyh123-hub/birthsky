// Assertions for overlay.js (pick, dirty flag, focus / asterism lookup, ridge clip, reticle, label
// collisions with the stage text, straight B horizon, stroke growth and fades) and a perf / allocation
// probe, in headless Chromium through src/dev/overlay.html.   node tools/dev/test-overlay.mjs
import { start } from './overlay-harness.mjs';

const h = await start();
let failed = 0;
try {
  const page = await h.open('dev/overlay.html');
  const res = await page.evaluate(() => window.tests());
  for (const r of res) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : '  ' + JSON.stringify(r.detail)}`);
  }
  console.log(`${res.length - failed}/${res.length} passed`);
  const perf = await page.evaluate(() => window.perf());
  console.log('perf', JSON.stringify(perf));
  if (h.errors.length) { console.log('errors:\n' + h.errors.join('\n')); failed++; }
} finally {
  await h.close();
}
process.exit(failed ? 1 : 0);
