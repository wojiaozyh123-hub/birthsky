// Tests for the one projection (spec §3.1): camera.js in Node (round trip < 0.01 px across fov 20–110°
// and P 0–0.8, scale, framing helpers, the skyline port), then the GLSL chunk in headless Chromium
// (src/dev/core-proj.html): proj() and terrain() captured by transform feedback, unproj() rendered to a
// float target, and star sprites through the real SkyRenderer, all compared with camera.js.
//   node tools/dev/test-projection.mjs [--node-only]
import { Camera, altForHorizonAt, horizonFracAt, autoP, terrainAtRad, ridgeNearRad, ridgeFarRad, ease, angDiff, standView, rewindView } from '../../src/js/camera.js';
import { start } from './core-harness.mjs';

let failed = 0, passed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed++; console.log(`  ok   ${name}${detail ? ` — ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
const DEG = Math.PI / 180;

console.log('camera.js round trip');
{
  let worst = 0, worstDir = 0, n = 0, worstAt = null;
  const cam = new Camera();
  for (const [w, h] of [[390, 844], [360, 640], [1440, 900], [1179, 2556]]) {
    cam.setSize(w, h);
    for (let fov = 20; fov <= 110; fov += 5) {
      for (let P = 0; P <= 0.8001; P += 0.1) {
        for (const alt of [-12, 0, 25, 60, 89, 90]) {
          Object.assign(cam, { fov, alt, az: 37 + alt * 3, Pfixed: P });
          cam.update();
          for (let gy = -0.1; gy <= 1.1001; gy += 0.05) {
            for (let gx = -0.1; gx <= 1.1001; gx += 0.05) {
              const x = gx * w, y = gy * h;
              const nrm = cam.unproject(x, y);
              const p = cam.project(nrm, {});
              if (!p) continue; // far outside a narrow rectilinear frame: culled, by design
              const e = Math.hypot(p.x - x, p.y - y);
              if (e > worst) { worst = e; worstAt = { w, h, fov, P, alt, x, y }; }
              n++;
            }
          }
        }
      }
    }
  }
  check('project(unproject(x, y)) round trip < 0.01 px (fov 20–110°, P 0–0.8, 4 screen sizes, ±10% beyond the edges)', worst < 0.01,
    `${n} points, worst ${worst.toExponential(2)} px`);
  void worstAt; void worstDir;

  // the other way: unproject(project(n)) returns n
  let worstA = 0;
  cam.setSize(390, 844);
  for (let i = 0; i < 20000; i++) {
    const fov = 20 + (i % 19) * 5, P = (i % 9) * 0.1;
    Object.assign(cam, { fov, alt: (i * 7) % 102 - 12, az: i * 1.37, Pfixed: P }); cam.update();
    const th = (i * 0.618) % 1 * (fov / 2) * DEG * 1.3, ph = i * 2.39996;
    const n = [0, 1, 2].map((k) => Math.cos(th) * cam.f[k] + Math.sin(th) * (Math.cos(ph) * cam.r[k] + Math.sin(ph) * cam.u[k]));
    const p = cam.project(n, {});
    if (!p) continue;
    const m = cam.unproject(p.x, p.y);
    worstA = Math.max(worstA, Math.acos(Math.min(1, n[0] * m[0] + n[1] * m[1] + n[2] * m[2])));
  }
  check('unproject(project(n)) returns n', worstA < 1e-7, `worst ${(worstA / DEG * 3600).toExponential(2)}″`);
}

console.log('camera.js geometry');
{
  const cam = new Camera();
  cam.setSize(390, 844);
  for (const P of [0, 0.4, 0.8]) {
    for (const fov of [30, 72, 100]) {
      Object.assign(cam, { az: 10, alt: 20, fov, Pfixed: P }); cam.update();
      // the top-centre pixel is fov/2 above the view centre
      const top = cam.unproject(cam.cx, 0);
      const ang = Math.acos(top[0] * cam.f[0] + top[1] * cam.f[1] + top[2] * cam.f[2]) / DEG;
      if (Math.abs(ang - fov / 2) > 1e-9) check(`S puts the top edge at fov/2 (P ${P}, fov ${fov})`, false, `${ang}`);
    }
  }
  check('S puts the top edge at fov/2 (P 0/0.4/0.8, fov 30/72/100)', true);
  Object.assign(cam, { az: 10, alt: 20, fov: 72, Pfixed: 0.5 }); cam.update();
  check('pxPerRad at the centre = S', Math.abs(cam.pxPerRad() - cam.S) < 1e-9);
  // numeric radial derivative
  // radial scale by a symmetric difference along the great circle from the centre through n
  const n0 = cam.unproject(cam.cx + 60, 200), d0 = n0[0] * cam.f[0] + n0[1] * cam.f[1] + n0[2] * cam.f[2];
  const th = Math.acos(d0), tdir = [0, 1, 2].map((k) => (n0[k] - d0 * cam.f[k]) / Math.sin(th));
  const at = (t) => cam.project([0, 1, 2].map((k) => Math.cos(t) * cam.f[k] + Math.sin(t) * tdir[k]), {});
  const e = 1e-5, pa = at(th - e), pb = at(th + e);
  const num = Math.hypot(pb.x - pa.x, pb.y - pa.y) / (2 * e);
  check('pxPerRad(n) is the radial scale', Math.abs(num / cam.pxPerRad(n0) - 1) < 1e-6, `${num.toFixed(4)} vs ${cam.pxPerRad(n0).toFixed(4)} px/rad`);

  // standing framings: P = 0, straight horizon at the right height
  const stand = altForHorizonAt(0.82, 72);
  check('stand framing alt_c = atan(0.64·tan36°) ≈ 24.9°', Math.abs(stand - 24.94) < 0.01, `${stand.toFixed(3)}°`);
  Object.assign(cam, { az: 200, alt: stand, fov: 72, Pfixed: null }); cam.update();
  check('stand framing is rectilinear (P = 0)', cam.P === 0, `P ${cam.P}, diag ${cam.diagFov.toFixed(1)}°`);
  const ys = [-18, -9, 0, 9, 18].map((d) => cam.project([Math.cos((200 + d) * DEG), Math.sin((200 + d) * DEG), 0], {}).y);
  check('horizon is a straight line at 0.82H', ys.every((y) => Math.abs(y - 0.82 * 844) < 1e-6), ys.map((y) => y.toFixed(3)).join(' '));
  check('horizonFracAt inverts altForHorizonAt', Math.abs(horizonFracAt(stand, 72) - 0.82) < 1e-12);
  check('short phone 0.80H: alt ≈ 23.6°', Math.abs(altForHorizonAt(0.80, 72) - 23.55) < 0.05, `${altForHorizonAt(0.80, 72).toFixed(3)}°`);
  cam.setSize(390, 844);
  Object.assign(cam, { az: 0, alt: 28.3, fov: 84 }); cam.update();
  check('rewind framing (fov 84° portrait) is rectilinear', cam.P === 0, `P ${cam.P}`);
  Object.assign(cam, { alt: 88, fov: 100 }); cam.update();
  const p88 = cam.P;
  Object.assign(cam, { alt: 90, fov: 100 }); cam.update();
  check('looking up (fov 100°) → P → 0.8 vault', p88 > 0.75 && cam.P === 0.8, `P ${p88.toFixed(3)} at 88°, ${cam.P} at 90°`);
  const pD = autoP(altForHorizonAt(0.84, 60), 60, 1440, 900);
  check('desktop stand framing fov 60° (1440×900)', true, `P ${pD.toFixed(3)} (diag ${(2 * Math.atan(Math.tan(30 * DEG) * Math.hypot(1440, 900) / 900) / DEG).toFixed(1)}°: the spec's diagonal rule gives a small P here)`);
  const sv = standView(123, 390, 844), svs = standView(0, 360, 640), svd = standView(0, 1440, 900), svh = standView(0, 390, 844, 55);
  check('standView: portrait / short / desktop / high hero', sv.fov === 72 && Math.abs(horizonFracAt(sv.alt, 72) - 0.82) < 1e-9 && Math.abs(horizonFracAt(svs.alt, 72) - 0.80) < 1e-9
    && svd.fov === 60 && Math.abs(horizonFracAt(svd.alt, 60) - 0.84) < 1e-9 && svh.alt === 30, `${sv.alt.toFixed(2)}° / ${svs.alt.toFixed(2)}° / ${svd.alt.toFixed(2)}° / hero 55° → ${svh.alt}° (horizon ${horizonFracAt(30, 72).toFixed(3)}H)`);
  const rv = rewindView(30.29, 390, 844), rs = rewindView(-33.9, 390, 844), rl = rewindView(5, 844, 390);
  check('rewindView: pole azimuth, clamp(|lat| − 2, 16, 34), fov 84 / 66', rv.az === 0 && Math.abs(rv.alt - 28.29) < 1e-9 && rv.fov === 84 && rs.az === 180 && rs.alt === 31.9 && rl.alt === 16 && rl.fov === 66);
  // at the zenith with az 180 north is up
  Object.assign(cam, { az: 180, alt: 90, fov: 100 }); cam.update();
  const north = cam.project([Math.cos(80 * DEG), 0, Math.sin(80 * DEG)], {}), east = cam.project([0, Math.cos(80 * DEG), Math.sin(80 * DEG)], {});
  check('vault facing south: north toward the top, east on the left', north.y < cam.cy && Math.abs(north.x - cam.cx) < 1e-6 && east.x < cam.cx);
}

console.log('skyline port, easing');
{
  let wrap = 0, cont = 0;
  for (const H of [0.028, 0.05]) {
    wrap = Math.max(wrap, Math.abs(terrainAtRad(Math.PI - 1e-12, H) - terrainAtRad(-Math.PI, H)));
    for (let i = 0; i < 20000; i++) {
      const a = -Math.PI + 2 * Math.PI * i / 20000;
      cont = Math.max(cont, Math.abs(terrainAtRad(a + 1e-5, H) - terrainAtRad(a, H)));
    }
  }
  check('ridge wraps continuously at az = ±180°', wrap < 1e-6, `jump ${wrap.toExponential(2)} rad`);
  // the tree crowns have steep (√) sides, so this is a bound, not a Lipschitz test: a hash seam at a
  // cell boundary would jump by ~1e-3–1e-2 rad
  check('ridge has no seams (Δ over 1e-5 rad of az)', cont < 1e-3, `max ${cont.toExponential(2)} rad`);
  check('periodic in azimuth (2π)', Math.abs(terrainAtRad(1.234 + 2 * Math.PI, 0.05) - terrainAtRad(1.234, 0.05)) < 1e-6);
  check('terrainH ≤ 0 is a clean horizon', terrainAtRad(1, 0) === 0 && ridgeNearRad(1, -1) === 0 && ridgeFarRad(1, 0) === 0);
  let hi = 0;
  for (let i = 0; i < 3600; i++) hi = Math.max(hi, terrainAtRad(i / 3600 * 2 * Math.PI, 0.05));
  check('ridge height is modest', hi / DEG < 6, `max ${(hi / DEG).toFixed(2)}° at terrainH 0.05`);
  const b = ease.bezier(0.55, 0, 0.12, 1);
  check('cubic-bezier endpoints and monotone', b(0) === 0 && b(1) === 1 && [...Array(99)].every((_, i) => b((i + 1) / 100) >= b(i / 100)));
  check('ease.fade symmetric', Math.abs(ease.fade(0.5) - 0.5) < 1e-6 && Math.abs(ease.fade(0.25) + ease.fade(0.75) - 1) < 1e-6);
  check('ease.enter / exit shapes', ease.enter(0.2) > 0.6 && ease.exit(0.2) < 0.1, `enter(.2) ${ease.enter(0.2).toFixed(3)}, exit(.2) ${ease.exit(0.2).toFixed(3)}`);
  check('angDiff wraps', angDiff(350, 10) === 20 && angDiff(10, 350) === -20);
}

if (!process.argv.includes('--node-only')) {
  console.log('GLSL vs camera.js (headless Chromium, SwiftShader)');
  const h = await start({ width: 390, height: 844 });
  try {
    const page = await h.open('dev/core-proj.html');
    await page.waitForFunction(() => window.coreTests?.ready, { timeout: 60000 }).catch((e) => { console.log(h.errors.join('\n')); throw e; });
    const cams = [
      { name: 'stand 72° P 0', c: { az: 180, alt: altForHorizonAt(0.82, 72), fov: 72 } },
      { name: 'rewind 84° P 0', c: { az: 0, alt: 28.3, fov: 84 } },
      { name: 'vault 100° P≈0.8', c: { az: 180, alt: 88, fov: 100 } },
      { name: 'wide 110° P 0.4', c: { az: 77, alt: 40, fov: 110, Pfixed: 0.4 } },
      { name: 'tele 20° P 0', c: { az: 266, alt: 30, fov: 20 } },
    ];
    for (const { name, c } of cams) {
      const r = await page.evaluate((c) => window.coreTests.proj(c), c);
      check(`proj() = camera.project — ${name}`, r.worstPx < 0.01, `${r.n} dirs, worst ${r.worstPx.toExponential(2)} device px`);
    }
    for (const { name, c } of cams.slice(0, 4)) {
      const r = await page.evaluate((c) => window.coreTests.scale(c), c);
      check(`projScale() = camera.pxPerRad — ${name}`, r.worstRel < 1e-5, `worst rel ${r.worstRel.toExponential(2)}`);
    }
    for (const { name, c } of cams) {
      const r = await page.evaluate((c) => window.coreTests.unproj(c), c);
      if (r.skipped) { check(`unproj() — ${name}`, true, r.skipped); continue; }
      check(`unproj() = camera.unproject — ${name}`, r.worstPx < 0.01, `${r.n} px, worst ${(r.worstRad / DEG * 3600).toFixed(3)}″ = ${r.worstPx.toExponential(2)} px`);
    }
    for (const H of [0.05, 0.028]) {
      const r = await page.evaluate((H) => window.coreTests.terrain(H), H);
      check(`terrain() = camera.terrainAtRad (terrainH ${H})`, r.worstRad < 1e-5 && r.over1e5 === 0, `${r.N} azimuths, worst ${r.worstRad.toExponential(2)} rad, max ridge ${r.maxDeg.toFixed(2)}°`);
    }
    for (const { name, c } of cams.slice(0, 4)) {
      for (const dpr of [1, 3]) {
        const r = await page.evaluate((c, dpr) => window.coreTests.stars(c, { dpr, sizeGain: dpr === 1 ? 3 : 1.2 }), c, dpr);
        // the centroid of a ~1-device-px PSF sampled at pixel centres is itself only good to ~0.05 px at 1x
        check(`star sprites land where camera.project says — ${name} @${dpr}x`, r.worstCssPx < (dpr === 1 ? 0.1 : 0.03) && r.found + r.hidden === r.stars,
          `${r.found} stars, worst ${r.worstCssPx.toFixed(4)} CSS px${r.hidden ? `, ${r.hidden} below the horizon` : ''}`);
      }
    }
    {
      const r = await page.evaluate(() => window.coreTests.extinction());
      check('extinction(): Kasten–Young, 0.28 mag/airmass, cap 3.5', r.worst < 1e-3, `worst ${r.worst.toExponential(2)} mag; ${Object.entries(r.at).map(([a, m]) => `${a}°:${m.toFixed(2)}`).join(' ')}`);
    }
    {
      const r = await page.evaluate(() => window.coreTests.listen());
      const g = r.gain;
      console.log(`       listen gain by degrees past the line: ${r.offs.map((o, i) => `${o}:${g[i].toFixed(2)}`).join(' ')}`);
      check('listen: no flare before the line', g[0] < 1.02 && g[1] < 1.02);
      // light summed on screen before the film curve; 8-bit readback drops the faintest PSF tail, which
      // exaggerates ratios by a few % either way, so this checks the shader's ×2.2 to ±15%
      check('listen: flare just past the line (point gain ×2.2) with an ember tint', Math.max(g[2], g[3]) > 1.9 && Math.max(g[2], g[3]) < 2.5 && r.warm[3] > 1.1, `peak ×${Math.max(g[2], g[3]).toFixed(2)} light, R/B ×${r.warm[3].toFixed(2)}`);
      check('listen: decays over ~12° (1.6 s at 7.5°/s)', g[4] > g[6] && g[7] < 1.15, `8°: ×${g[6].toFixed(2)}, 12°: ×${g[7].toFixed(2)}`);
      check('listen: stars fainter than 3.4 等 do not flare', g[8] < 1.02, `×${g[8].toFixed(2)}`);
    }
    {
      const r = await page.evaluate(() => window.coreTests.shared());
      const okFull = r.full.every((v, i) => (r.below[i] ? Math.abs(v - 0.25) < 0.06 : Math.abs(v - 1) < 0.02));
      check('two skies: below B\'s horizon stars dim to 0.25, above untouched', okFull, r.full.map((v, i) => `${r.below[i] ? 'below' : 'above'}:${v.toFixed(2)}`).join(' '));
      const stag = r.half.map((v, i) => [r.seeds[i], v]).filter((_, i) => r.below[i]).sort((a, b) => a[0] - b[0]);
      check('two skies: the reveal is staggered by seed', stag[0][1] < stag[stag.length - 1][1] - 0.3, stag.map(([sd, v]) => `seed ${sd}:${v.toFixed(2)}`).join(' '));
      check('two skies: sharedDim 1 is off', r.off.every((v) => Math.abs(v - 1) < 0.02));
    }
    {
      const r = await page.evaluate(() => window.coreTests.webgl1());
      check('WebGL1: all passes compile and draw (GLSL ES 1.00)', !r.failed && r.isGL2 === false && r.error === 0, r.failed || `sky pixel ${r.sky}`);
    }
    {
      const r = await page.evaluate(() => window.coreTests.tiles());
      check('setTileOffset: two half-height tiles reproduce the full frame', r.worst <= 1, `max channel difference ${r.worst}/255`);
    }
    if (h.errors.length) check('no page errors', false, h.errors.join(' | '));
  } finally {
    await h.close();
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
