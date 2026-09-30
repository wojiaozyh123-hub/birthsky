// WebGL sky: night air, skyline and Milky Way (one full-screen pass, including the band's resolved
// star grain when the view is magnified), stars, deep stars and star dust (additive point sprites with
// a photographic profile), and a long-exposure buffer for star trails (drawn as exact motion-blurred
// streaks, so they stay continuous at any speed, framing or frame rate).
// GLSL ES 1.00 so it runs on WebGL1 and WebGL2.
import { mulberry32 } from './catalog.js';

const PREC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

// skyline: a low ring of distant hills, periodic in azimuth. Must match between sky and star passes.
const TERRAIN = `
uniform float uTerrainH;
float th1(float n) { return fract(sin(n * 12.9898 + 4.1) * 43758.5453); }
float tpn(float x, float P) {
  float i = floor(x); float f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(th1(mod(i, P)), th1(mod(i + 1.0, P)), f);
}
// stands of trees along the near ridge: rows of rounded crowns of uneven height, only in some
// stretches, so the skyline has a human scale without turning into a fence
float crown(float x, float P, float s) {
  float c = floor(x);
  float u = fract(x) * 2.0 - 1.0;
  float r = th1(mod(c, P) + s);
  return sqrt(max(0.0, 1.0 - u * u)) * step(0.22, r) * (0.3 + 0.7 * r);
}
float trees(float t) {
  // three interleaved rows of crowns of different sizes: an irregular canopy, not a scalloped edge
  float k = max(crown(t * 540.0, 540.0, 0.0), 0.8 * crown(t * 870.0 + 0.37, 870.0, 3.1));
  k = max(k, 0.6 * crown(t * 1390.0 + 0.61, 1390.0, 7.7));
  float stand = smoothstep(0.55, 0.78, tpn(t * 31.0 + 0.7, 31.0));
  return k * stand;
}
float ridgeNear(float az) {
  if (uTerrainH <= 0.0) return 0.0; // whole-sky charts and posters: a clean horizon circle
  float t = az / 6.2831853 + 0.5;
  float h = 0.55 * tpn(t * 9.0, 9.0) + 0.3 * tpn(t * 23.0, 23.0) + 0.15 * tpn(t * 61.0, 61.0);
  return uTerrainH * (h * h * 1.7 - 0.12 + 0.13 * trees(t));
}
float ridgeFar(float az) {
  if (uTerrainH <= 0.0) return 0.0;
  float t = az / 6.2831853 + 0.5;
  float h = 0.6 * tpn(t * 5.0 + 0.37, 5.0) + 0.4 * tpn(t * 17.0 + 0.11, 17.0);
  return uTerrainH * (h * h * 2.3 - 0.05);
}
float terrain(float az) { return max(ridgeNear(az), ridgeFar(az)); }
`;

const CAMERA = `
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uScale;
uniform vec3 uF;
uniform vec3 uU;
uniform vec3 uR;
`;

// Star photometry shared by the point and the streak shaders. Everything is in device pixels.
//   pr     device px per CSS px of star (devicePixelRatio × sizeGain; posters/wallpapers pass sizeGain)
//   sigma  core PSF: ~0.27 CSS px (FWHM ≈ 1.9 device px at 3×), never under 0.62 device px, so a
//          faint star is a true pinpoint that still never aliases into a crawling dot
//   flux   linear, 1 at V = 6
// The profile is a photographic one: a Gaussian core whose peak carries the brightness of faint stars
// (compressed, so the V 7–8 stars still read on a phone as fine dust), plus a Moffat wing that grows
// almost linearly with flux. The wing only shows on bright stars, and because it falls off as a power
// law their saturated disc and soft coloured glow grow steadily with brightness, as on film.
const PHOTOMETRY = `
float starSigma(float pr) { return max(0.62, 0.27 * pr); }
float starFlux(float m) { return exp2(-1.3287712 * (m - 6.0)); }
// keeps the energy per CSS px² about constant across pixel ratios (a little brighter than exact at
// low ratios, where the core cannot shrink further)
float starNorm(float pr, float sigma) { return pow(0.27 * pr / sigma, 1.2); }
float starCore(float F) { return pow(F, 0.61); }
float starWing(float F) { return 0.03 * pow(F, 0.85); }
// atmospheric extinction (mag) at height h (radians) above the skyline
float extinction(float h) { return min(0.18 * (1.0 / max(sin(h + 0.02), 0.05) - 1.0), 2.6); }
// hue of a star, a little richer than the catalogue's whisper and normalised to a max channel of 1
vec3 starHue(vec3 c, float sat) {
  vec3 h = max(mix(vec3(dot(c, vec3(0.30, 0.59, 0.11))), c, sat), 0.0);
  return h / max(max(h.r, h.g), max(h.b, 1e-3));
}
`;

const FULLSCREEN_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const SKY_FS = `${PREC}${CAMERA}${TERRAIN}
uniform mat3 uMt;
uniform sampler2D uMW;
uniform sampler2D uNoise;
uniform vec3 uSun;
uniform vec3 uMoon;
uniform float uMoonIllum;
uniform float uDay;
uniform float uTwilight;
uniform float uMwAmt;
uniform vec3 uBg;
uniform float uDome;
uniform float uExposure;
uniform float uGrain;
uniform float uFlash;
uniform float uVignette;
uniform float uStarGrain;
uniform float uPr;

const vec3 G0 = vec3(-0.0548755604, -0.8734370902, -0.4838350155);
const vec3 G1 = vec3(0.4941094279, -0.4448296300, 0.7469822445);
const vec3 G2 = vec3(-0.8676661490, -0.1980763734, 0.4559837762);

// weight of a noise octave whose cells are 'cell' radians wide, seen at 'px' radians per pixel:
// octaves finer than ~2 px fade to their mean, so nothing shimmers while the sky turns
float lod(float cell, float px) { return smoothstep(1.6, 4.0, cell / px); }

#ifdef GL_FRAGMENT_PRECISION_HIGH
vec3 hash32(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
// One octave of the Milky Way's unresolved stars: one candidate per cell of a grid in galactic
// coordinates (fixed on the sky, so nothing swims), present with probability ≈ 'dens', drawn with the
// same pinpoint profile as the catalogue stars. Returns peak-normalised light at this pixel.
float grainLayer(vec2 g, float cb, float cell, float dens, float pxAng, float s2, float seed) {
  vec2 c = g / cell;
  vec2 ci = floor(c);
  vec3 h = hash32(ci + seed);
  vec2 d = (c - ci - 0.2 - 0.6 * h.xy) * (cell / pxAng);
  d.x *= cb;
  float b = fract(h.z * 17.31 + h.x * 5.13);
  // presence ramps in over a little density (not a step), so stars fade in smoothly while zooming
  return clamp((dens - h.z) * 8.0, 0.0, 1.0) * (0.12 + 0.88 * b * b * b) * exp(-dot(d, d) * s2);
}
#endif

void main() {
  vec2 p = (gl_FragCoord.xy - uCenter) / uScale;
  float rho2 = dot(p, p);
  vec3 v = normalize((4.0 * p.x * uR + 4.0 * p.y * uU + (4.0 - rho2) * uF) / (4.0 + rho2));
  float alt = asin(clamp(v.z, -1.0, 1.0));
  float az = atan(v.y, v.x);
  float pxAng = 4.0 / ((4.0 + rho2) * uScale);
  float nearTop = ridgeNear(az);
  float th = max(nearTop, ridgeFar(az)); // = terrain(az), sharing the near ridge with the ground below
  float skyMask = smoothstep(-pxAng, pxAng, alt - th);
  float h = clamp(alt / 1.5707963, 0.0, 1.0);
  float a0 = max(alt, 0.0);

  // Night air: a deep blue-black overhead (never a dead 0), lighter toward the horizon where we look
  // through more of the airglow layer; a faint green-teal airglow band a few degrees up, and a pale,
  // slightly warm light dome right on the skyline. On a whole-sky chart that makes a soft bright limb.
  vec3 col = vec3(0.011, 0.014, 0.028) + vec3(0.019, 0.025, 0.042) * exp(-a0 * 2.4);
  float band = a0 / 0.12 * exp(1.0 - a0 / 0.12);
  col += vec3(0.005, 0.015, 0.011) * band;
  col += vec3(0.034, 0.030, 0.026) * exp(-a0 * 14.0);
  col += vec3(0.013, 0.018, 0.034) * exp(-a0 * 5.0) * uDome;

  vec3 e = uMt * v;
  float ra = atan(e.y, e.x);
  float dec = asin(clamp(e.z, -1.0, 1.0));
  vec2 uv = vec2(ra * 0.15915494, 0.5 - dec * 0.31830989);
  float t = texture2D(uMW, uv).r;
  float L = t * t; // the map stores sqrt(luminance)
  float mwVis = uMwAmt * smoothstep(-0.02, 0.22, alt) * (1.0 - 0.85 * uDay);
  if (L > 0.0004 && mwVis > 0.0) {
    vec3 g = vec3(dot(G0, e), dot(G1, e), dot(G2, e));
    float gl = atan(g.y, g.x);
    float gb = asin(clamp(g.z, -1.0, 1.0));
    // mottling finer than the map (galactic coordinates: no seam where the band crosses RA 0h)
    vec2 guv = vec2(gl * 0.15915494, gb * 0.31830989);
    vec4 n1 = texture2D(uNoise, guv * vec2(24.0, 12.0));
    float c1 = 0.2618 / 16.0 * 0.5; // blob size of the 16-cell channel (radians)
    float d = 1.0;
    d += 0.10 * lod(c1, pxAng) * (n1.r - 0.5) * 2.0;
    d += 0.12 * lod(c1 * 0.5, pxAng) * (n1.g - 0.5) * 2.0;
    d += 0.12 * lod(c1 * 0.25, pxAng) * (n1.b - 0.5) * 2.0;
    // contrast: the faint outer band recedes, the star clouds stand out
    float mw = pow(L * max(d, 0.0), 1.3);
    // the bulge glows warm; the bright star clouds elsewhere a clean, faintly cool white, and the
    // faint outer band a neutral, slightly warm grey (no blue cast at the edges)
    float warm = exp(-gl * gl / 0.30) * exp(-gb * gb / 0.03) * smoothstep(0.02, 0.4, L);
    vec3 tint = mix(vec3(0.98, 0.95, 0.90), vec3(0.93, 0.945, 0.98), smoothstep(0.04, 0.45, L));
    tint = mix(tint, vec3(1.0, 0.86, 0.68), warm);
    // Where the view is magnified enough to resolve them, part of the glow turns into its stars:
    // octaves of pinpoints whose density follows the band's brightness (so the dark lanes empty out).
    float res = 0.0;
    vec3 grain = vec3(0.0);
#ifdef GL_FRAGMENT_PRECISION_HIGH
    if (uStarGrain > 0.0) {
      vec2 gg = vec2(gl, gb);
      float cb = cos(gb);
      float sg = max(0.62, 0.27 * uPr);
      float s2 = 0.5 / (sg * sg);
      float Ld = min(L * 1.4, 0.8);
      float gsum = 0.0;
      float cell = 0.0032;
      for (int i = 0; i < 4; i++) {
        float w = smoothstep(2.4, 5.0, cell / pxAng);
        if (w > 0.0) {
          gsum += w * (0.3 - 0.05 * float(i)) * grainLayer(gg, cb, cell, Ld * w, pxAng, s2, float(i) * 17.0);
          res = max(res, w);
        }
        cell *= 0.5;
      }
      grain = mix(tint, vec3(1.0), 0.3) * gsum * uStarGrain;
    }
#endif
    // a soft shoulder: faint band clearly there, bright star clouds luminous but never blown out
    col += (tint * (1.0 - exp(-mw * 2.6)) * 0.68 * (1.0 - 0.2 * res * uStarGrain) + grain) * mwVis;
  }

  float angM = acos(clamp(dot(v, uMoon), -1.0, 1.0));
  float moonUp = smoothstep(-0.05, 0.05, uMoon.z);
  col += vec3(0.70, 0.76, 0.92) * uMoonIllum * moonUp * (0.12 * exp(-angM * 18.0) + 0.025 * exp(-angM * 3.0));

  float cs = dot(v, uSun);
  vec3 dusk = mix(vec3(0.045, 0.065, 0.18), vec3(0.98, 0.48, 0.24), exp(-a0 * 5.0) * pow(0.5 + 0.5 * cs, 2.5));
  col = mix(col, dusk, uTwilight);
  vec3 day = mix(vec3(0.60, 0.75, 0.92), vec3(0.17, 0.37, 0.72), pow(h, 0.5));
  day += vec3(1.0, 0.93, 0.8) * (pow(max(cs, 0.0), 90.0) * 0.9 + pow(max(cs, 0.0), 6.0) * 0.14);
  col = mix(col, day, uDay);

  float below = max(th - alt, 0.0);
  vec3 groundDome = uBg + vec3(0.030, 0.042, 0.080) * exp(-below * 10.0) * (1.0 - uDay * 0.4);
  float farMask = step(nearTop, alt);   // on the far ridge, not the near one
  // the land: hills in silhouette against the glow, the far ridge a shade lighter (air between us
  // and it), the near ground falling off to black toward our feet
  vec3 groundLand = mix(vec3(0.011, 0.013, 0.020), vec3(0.003, 0.004, 0.006), clamp(below * 2.5, 0.0, 1.0));
  groundLand = mix(groundLand, vec3(0.022, 0.027, 0.040) + vec3(0.012, 0.015, 0.022) * exp(-below * 40.0), farMask * (1.0 - uDome));
  groundLand += mix(vec3(0.010, 0.012, 0.018), dusk * 0.10, uTwilight) * exp(-below * 30.0);
  groundLand += day * 0.08 * uDay;
  vec3 ground = mix(groundLand, groundDome, uDome);
  vec3 outc = mix(ground, col, skyMask);
  outc += vec3(0.012, 0.014, 0.020) * exp(-abs(alt - th) * 30.0) * skyMask * (1.0 - uDay);

  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  outc *= 1.0 - uVignette * dot(q, q);
  outc += uFlash * vec3(0.95, 0.88, 0.76) * exp(-rho2 * 0.35);
  // static 1-LSB dither (interleaved gradient noise: blue-noise-like, no visible pattern, no crawl)
  // so the dark gradients never band
  float gr = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  gl_FragColor = vec4(outc * uExposure + (gr - 0.5) * uGrain, 1.0);
}`;

const STAR_VS = `${CAMERA}${TERRAIN}${PHOTOMETRY}
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec4 aInfo; // mag, seed, kind (0 star / 1 dust / 2 deep star), index
uniform mat3 uM;
uniform float uDpr;
uniform float uTime;
uniform float uReveal;
uniform float uStarGain;
uniform float uDustGain;
uniform float uSizeGain;
uniform float uDay;
uniform float uSweep;
uniform float uSweepOn;
uniform float uSel;
uniform float uMaxPoint;
uniform float uTwinkle;
uniform float uDeep;
varying vec3 vCol;
varying vec4 vA; // core peak, 1/(2σ²), wing peak, 1/α² (Moffat)
varying vec4 vB; // spike peak, 1/spike length, 1/(2·spike width²), sprite half-size

void cull() { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; }

void main() {
  vec3 n = uM * aPos;
  float alt = asin(clamp(n.z, -1.0, 1.0));
  float az = atan(n.y, n.x);
  float th = terrain(az);
  float d = dot(n, uF);
  if (d < -0.9 || alt < th - 0.02) { cull(); return; }
  float k = 2.0 / (1.0 + d);
  vec2 p = uCenter + uScale * k * vec2(dot(n, uR), dot(n, uU));
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);

  float mag = aInfo.x;
  float seed = aInfo.y;
  float kind = aInfo.z;
  float dust = 1.0 - step(0.5, abs(kind - 1.0));
  float deep = step(1.5, kind);
  float named = (1.0 - dust) * (1.0 - deep);

  float pr = uDpr * uSizeGain;
  float pxPerRad = uScale * k;
  // How deep we see depends on how magnified the sky is: a whole-sky chart shows the naked-eye stars,
  // a full-screen view reaches V≈8, so density always reads as depth, never as noise. Continuous in
  // zoom, and every star fades over ~0.8 mag, so nothing pops.
  float cssPerDeg = pxPerRad / pr * 0.01745329;
  float lim = 6.35 + 1.95 * clamp(log2(max(cssPerDeg, 0.05) / 1.6) / 2.9, 0.0, 1.0);
  lim = min(lim, uReveal + 1.8 * smoothstep(4.5, 6.6, uReveal));
  float vis = smoothstep(lim + 0.4, lim - 0.45, mag) * mix(1.0, uDeep, deep);
  float sink = clamp((alt - th) * pxPerRad / 1.5 + 0.5, 0.0, 1.0); // sink behind the ridge, don't pop
  vis *= sink;
  // zooming in gathers more light per star, like a longer lens: stars brighten (never shrink) and
  // the fainter ones come forward
  float lens = 0.45 * clamp(log2(max(cssPerDeg, 0.05) / 8.0), 0.0, 2.0);
  float m = mag + extinction(alt - th) - lens;

  float lowness = 1.0 - clamp(alt / 1.1, 0.0, 1.0);
  float tw = 1.0 + uTwinkle * (0.02 + 0.12 * lowness * lowness) * named
    * (0.6 * sin(uTime * (0.8 + seed * 1.6) + seed * 61.0) + 0.4 * sin(uTime * (2.1 + seed * 2.3) + seed * 17.0));
  float since = mod(az - uSweep, 6.2831853);
  float flare = uSweepOn * exp(-since * 5.0) * step(mag, 4.2) * named;
  float sel = (1.0 - step(0.5, abs(aInfo.w - uSel))) * named;

  float sigma = starSigma(pr);
  float nrm = starNorm(pr, sigma);
  float F = starFlux(m);
  float gain = mix(uStarGain, uDustGain * smoothstep(5.9, 7.5, lim), dust) * (1.0 - 0.7 * uDay);
  if (dust > 0.5) vis = sink * smoothstep(-0.3, 0.3, alt);
  float g = vis * gain * tw * nrm;
  float Pc = starCore(F) * g * (1.0 + flare * 1.6 + sel * 1.2);
  // the glow is kept smaller on a zoomed-out whole-sky chart, where it would crowd the picture
  float Pw = starWing(F) * g * (1.0 + flare * 3.0 + sel * 2.5) * (1.0 - dust)
    * (0.45 + 0.55 * smoothstep(1.2, 6.0, cssPerDeg));
  float al = 1.5 * pr;
  float spike = smoothstep(1.3, -0.8, m) * named;
  float Sp = 0.2 * spike * vis * gain;
  float ell = (2.5 + 3.5 * spike) * pr;

  // sprite just large enough to hold everything brighter than ~1/255
  if (Pc < 0.004 && Pw < 0.004) { cull(); return; }
  if (Pw < 0.002) Pw = 0.0; // faint stars: no wing to evaluate
  // brighter stars also widen their core a little (steeper size curve toward the bright end)
  sigma *= 1.0 + 0.19 * max(0.0, 5.5 - m) * (1.0 - dust);
  float rc = sigma * sqrt(2.0 * log(max(Pc, 0.004) / 0.004));
  float rw = al * sqrt(max(pow(max(Pw, 0.004) / 0.004, 1.0 / 1.8) - 1.0, 0.0));
  float rs = ell * log(max(Sp, 0.004) / 0.004);
  float size = min(2.0 * max(max(rc, rw), rs) + 1.5, uMaxPoint);
  gl_PointSize = size;

  vA = vec4(Pc, 0.5 / (sigma * sigma), Pw, 1.0 / (al * al));
  vB = vec4(Sp, 1.0 / ell, 0.5 / (sigma * sigma * 0.5), size * 0.5);
  vec3 hue = starHue(aColor, 1.45);
  vCol = mix(hue, hue * vec3(1.0, 0.88, 0.70), flare * 0.7);
}`;

const STAR_FS = `${PREC}
varying vec3 vCol;
varying vec4 vA;
varying vec4 vB;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * (2.0 * vB.w);
  float r2 = dot(q, q);
  float xc = vA.x * exp(-r2 * vA.y);
  float x = xc;
  // Moffat wing, windowed to zero at the sprite's inscribed circle so a sprite clamped by the GPU's
  // point-size limit never shows a square edge
  if (vA.z > 0.0) x += vA.z * pow(1.0 + r2 * vA.w, -1.8) * clamp(1.3 - 1.3 * r2 / (vB.w * vB.w), 0.0, 1.0);
  if (vB.x > 0.0) {
    vec2 a = abs(q);
    x += vB.x * (exp(-a.x * vB.y - a.y * a.y * vB.z) + exp(-a.y * vB.y - a.x * a.x * vB.z));
  }
  // saturate like film, but keep the hue: the core only pales a little as it saturates, the glow
  // carries the colour, and nothing reaches pure white (max channel ≈ 0.93)
  float I = 1.0 - exp(-x);
  vec3 c = mix(vCol, mix(vCol, vec3(1.0), 0.4), smoothstep(0.55, 1.0, I) * xc / max(x, 1e-4));
  gl_FragColor = vec4(c * I * 0.93, 1.0);
}`;

// A star's light laid along one step of the sky's rotation: a quad around the segment a→b whose
// fragment shader integrates the Gaussian core along it exactly (erf). Consecutive steps telescope to
// a partition of unity, so a trail is one seamless line whose brightness depends on the star, not on
// the frame rate, the spin speed or how many pixels a step covers.
const TRAIL_VS = `${CAMERA}${TERRAIN}${PHOTOMETRY}
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec3 aInfo; // mag, end (−1 = a, +1 = b), side (−1 / +1)
uniform mat3 uMa;
uniform mat3 uMb;
uniform float uDpr;
uniform float uSizeGain;
uniform float uGain;
uniform float uTrailLim;
varying vec2 vUV;
varying vec3 vP; // peak, 1/(√2σ), length
varying vec3 vCol;

void main() {
  vec3 na = uMa * aPos, nb = uMb * aPos;
  float da = dot(na, uF), db = dot(nb, uF);
  float ha = asin(clamp(na.z, -1.0, 1.0)) - terrain(atan(na.y, na.x));
  float hb = asin(clamp(nb.z, -1.0, 1.0)) - terrain(atan(nb.y, nb.x));
  float mag = aInfo.x;
  if (min(da, db) < -0.8 || max(ha, hb) < -0.01 || mag > uTrailLim + 0.4) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ka = 2.0 / (1.0 + da), kb = 2.0 / (1.0 + db);
  vec2 pa = uCenter + uScale * ka * vec2(dot(na, uR), dot(na, uU));
  vec2 pb = uCenter + uScale * kb * vec2(dot(nb, uR), dot(nb, uU));
  vec2 dv = pb - pa;
  float len = length(dv);
  vec2 dir = len > 1e-3 ? dv / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  float pr = uDpr * uSizeGain;
  float sigma = starSigma(pr);
  float m = mag + extinction(min(ha, hb));
  float vis = clamp(min(ha, hb) * uScale * ka / 1.5 + 0.5, 0.0, 1.0) * smoothstep(uTrailLim + 0.4, uTrailLim - 0.4, mag);
  // compressed photometry: the faintest trailed stars draw fine threads, the brightest are a little
  // wider and brighter, never thick white bars (flux relative to V = 4.4)
  float P = 1.0 * pow(starFlux(m + 1.6), 0.45) * uGain * vis * starNorm(pr, sigma);
  sigma *= 1.0 + 0.09 * clamp(4.4 - m, 0.0, 6.0);
  float w = sigma * sqrt(2.0 * log(max(P, 0.002) / 0.002)) + 1.0;
  vec2 pos = (aInfo.y < 0.0 ? pa : pb) + dir * aInfo.y * w + nrm * aInfo.z * w;
  vUV = vec2(dot(pos - pa, dir), dot(pos - pa, nrm));
  vP = vec3(P, 0.70710678 / sigma, len);
  vCol = starHue(aColor, 1.6);
  gl_Position = P < 0.002 ? vec4(2.0, 2.0, 2.0, 1.0) : vec4(pos / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const TRAIL_FS = `${PREC}
varying vec2 vUV;
varying vec3 vP;
varying vec3 vCol;
float erfA(float x) { // Winitzki's approximation, |error| < 2e-4
  float x2 = x * x, a = 0.147 * x2;
  return sign(x) * sqrt(1.0 - exp(-x2 * (1.2732395 + a) / (1.0 + a)));
}
void main() {
  float s = vP.y;
  float across = exp(-vUV.y * vUV.y * s * s);
  float along = 0.5 * (erfA(vUV.x * s) - erfA((vUV.x - vP.z) * s));
  gl_FragColor = vec4(vCol * (vP.x * across * along), 1.0);
}`;

// Multiply the long exposure down (colour = ε, alpha = keep) with a reverse-subtract blend:
// dst·keep − ε, so faint residue fades all the way out instead of sticking in an 8-bit buffer.
const FADE_FS = `${PREC}
uniform float uK;
uniform float uEps;
void main() { gl_FragColor = vec4(uEps, uEps, uEps, uK); }`;

// Composite the exposure with a soft shoulder: linear in the faint trails, rolling off where bright
// trails overlap and never above 0.85, so even a dense bundle stays a luminous grey, not a white wall.
const BLIT_FS = `${PREC}
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uOpacity;
void main() {
  vec3 x = texture2D(uTex, gl_FragCoord.xy / uRes).rgb;
  vec3 y = mix(x, 0.45 + 0.4 * (1.0 - exp(-(x - 0.45) / 0.4)), step(0.45, x));
  gl_FragColor = vec4(y * uOpacity, 1.0);
}`;

const TRAIL_MAG = 4.8;
const TRAIL_ARC = 120; // degrees
const TRAIL_RAMP = 14; // degrees of rotation over which a new exposure fades in

/** Angle (degrees) of the rotation taking sky matrix A to B (both column-major rotations). */
function rotationDeg(A, B) {
  let tr = 0;
  for (let i = 0; i < 9; i++) tr += A[i] * B[i];
  return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 57.29578;
}

/** Tileable band-limited gradient noise: R/G/B/A = one octave each on 16/32/64/8-cell grids. */
function makeNoise(size = 256) {
  const rnd = mulberry32(11);
  const grids = [16, 32, 64, 8].map((g) => ({ g, a: Float32Array.from({ length: g * g }, () => rnd() * Math.PI * 2) }));
  const gn = ({ g, a }, u, v) => {
    const fx = u * g, fy = v * g, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy;
    const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10), sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
    const dot = (i, j, dx, dy) => { const t = a[(((j % g) + g) % g) * g + (((i % g) + g) % g)]; return Math.cos(t) * dx + Math.sin(t) * dy; };
    const n00 = dot(ix, iy, tx, ty), n10 = dot(ix + 1, iy, tx - 1, ty);
    const n01 = dot(ix, iy + 1, tx, ty - 1), n11 = dot(ix + 1, iy + 1, tx - 1, ty - 1);
    const top = n00 + (n10 - n00) * sx, bot = n01 + (n11 - n01) * sx;
    return top + (bot - top) * sy;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, o = (y * size + x) * 4;
      for (let c = 0; c < 4; c++) data[o + c] = Math.max(0, Math.min(255, Math.round(255 * (0.5 + 0.95 * gn(grids[c], u, v)))));
    }
  }
  return { size, data };
}

const smooth01 = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };

export class SkyRenderer {
  constructor(canvas, catalog, { preserve = false } = {}) {
    this.canvas = canvas;
    this.catalog = catalog;
    this.preserve = preserve;
    this.dpr = 1;
    this.cssW = 1; this.cssH = 1;
    this.lost = false;
    this.mt = new Float32Array(9);
    this.prevM = new Float32Array(9);
    this.hasPrevM = false;
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; });
    canvas.addEventListener('webglcontextrestored', () => { this.lost = false; this.init(); });
    this.init();
  }

  init() {
    const attrs = { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false,
      preserveDrawingBuffer: this.preserve, powerPreference: 'high-performance' };
    const gl = this.canvas.getContext('webgl2', attrs) || this.canvas.getContext('webgl', attrs);
    if (!gl) throw new Error('WebGL unavailable');
    this.gl = gl;
    this.isGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;

    this.progSky = this.program(FULLSCREEN_VS, SKY_FS);
    this.progStar = this.program(STAR_VS, STAR_FS);
    this.progTrail = this.program(TRAIL_VS, TRAIL_FS);
    this.progFade = this.program(FULLSCREEN_VS, FADE_FS);
    this.progBlit = this.program(FULLSCREEN_VS, BLIT_FS);

    this.triBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    this.starBuf = gl.createBuffer();
    this.deepCount = 0;
    this.uploadPoints();
    // deep stars already in hand (posters, wallpapers, a restored context) show at once
    this.deepT0 = this.deepCount ? -1e9 : 0;
    this.uploadTrails();

    this.mwTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.mwTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, gl.LUMINANCE, gl.UNSIGNED_BYTE, this.catalog.mwImg);
    this.texParams(gl.REPEAT, gl.CLAMP_TO_EDGE);

    const noise = makeNoise();
    this.noiseTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.noiseTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, noise.size, noise.size, 0, gl.RGBA, gl.UNSIGNED_BYTE, noise.data);
    this.texParams(gl.REPEAT, gl.REPEAT);

    this.fbo = null;
    this.fboW = 0; this.fboH = 0;
    this.fboFloat = false;
    this.hasPrevM = false;
  }

  /** stars, then deep stars (once loaded), then dust — one interleaved buffer, one draw call. */
  uploadPoints() {
    const gl = this.gl;
    const { stars, dust } = this.catalog;
    const deep = this.catalog.deep;
    const nDeep = deep ? deep.count : 0;
    const total = stars.count + nDeep + dust.count;
    const buf = new Float32Array(total * 10);
    const put = (src, i, o, kind, idx, rnd) => {
      buf.set(src.pos.subarray(i * 3, i * 3 + 3), o);
      buf.set(src.color.subarray(i * 3, i * 3 + 3), o + 3);
      buf[o + 6] = src.mag[i]; buf[o + 7] = rnd(); buf[o + 8] = kind; buf[o + 9] = idx;
    };
    // separate streams, so twinkle phases don't depend on whether the deep stars have arrived
    let rnd = mulberry32(3);
    for (let i = 0; i < stars.count; i++) put(stars, i, i * 10, 0, i, rnd);
    rnd = mulberry32(4);
    for (let i = 0; i < nDeep; i++) put(deep, i, (stars.count + i) * 10, 2, -1, rnd);
    rnd = mulberry32(5);
    for (let i = 0; i < dust.count; i++) put(dust, i, (stars.count + nDeep + i) * 10, 1, -1, rnd);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    this.starCount = stars.count;
    this.deepCount = nDeep;
    this.dustCount = dust.count;
    this.pointCount = total;
  }

  /** Four corners per bright star for the streak quads. */
  uploadTrails() {
    const gl = this.gl;
    const { stars } = this.catalog;
    let n = stars.mag.findIndex((m) => m > TRAIL_MAG);
    if (n < 0) n = stars.count;
    n = Math.min(n, 16383);
    const v = new Float32Array(n * 4 * 9);
    const idx = new Uint16Array(n * 6);
    const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 4; c++) {
        const o = (i * 4 + c) * 9;
        v.set(stars.pos.subarray(i * 3, i * 3 + 3), o);
        v.set(stars.color.subarray(i * 3, i * 3 + 3), o + 3);
        v[o + 6] = stars.mag[i]; v[o + 7] = corners[c][0]; v[o + 8] = corners[c][1];
      }
      idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    this.trailBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf);
    gl.bufferData(gl.ARRAY_BUFFER, v, gl.STATIC_DRAW);
    this.trailIdx = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.trailIdx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.trailCount = n;
  }

  texParams(wrapS, wrapT, filter) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter || gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapS);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapT);
  }

  program(vsSrc, fsSrc) {
    const gl = this.gl;
    const sh = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
        throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n'));
      }
      return s;
    };
    const p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS) && !gl.isContextLost()) throw new Error(gl.getProgramInfoLog(p));
    const uniforms = {};
    const nU = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < nU; i++) {
      const info = gl.getActiveUniform(p, i);
      uniforms[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name);
    }
    const attribs = {};
    const nA = gl.getProgramParameter(p, gl.ACTIVE_ATTRIBUTES);
    for (let i = 0; i < nA; i++) {
      const info = gl.getActiveAttrib(p, i);
      attribs[info.name] = gl.getAttribLocation(p, info.name);
    }
    return { p, u: uniforms, a: attribs, locs: Object.values(attribs).filter((l) => l >= 0) };
  }

  resize(cssW, cssH, dpr) {
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  /** Free the GPU context now (offscreen renderers for posters / wallpapers). */
  dispose() {
    this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
  }

  /** The long-exposure buffer: half-float where the GPU can render to it, 8-bit otherwise. */
  ensureFbo() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (this.fbo && this.fboW === w && this.fboH === h) return;
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.fboTex); }
    const make = (half) => {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      if (half && this.isGL2) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
      } else if (half) {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, half.HALF_FLOAT_OES, null);
      } else {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      }
      this.texParams(gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE, gl.NEAREST);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.deleteFramebuffer(fbo); gl.deleteTexture(tex);
        return null;
      }
      return { fbo, tex };
    };
    let halfExt = null;
    if (this.isGL2) halfExt = (gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')) ? true : null;
    else if (gl.getExtension('EXT_color_buffer_half_float')) halfExt = gl.getExtension('OES_texture_half_float');
    let t = null;
    try { t = halfExt ? make(halfExt) : null; } catch { t = null; }
    this.fboFloat = !!t;
    if (!t) t = make(null);
    this.fbo = t.fbo; this.fboTex = t.tex;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboW = w; this.fboH = h;
    this.hasPrevM = false;
  }

  setCamera(prog, cam) {
    const gl = this.gl, dpr = this.dpr, u = prog.u;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter, cam.cx * dpr, (this.cssH - cam.cy) * dpr);
    gl.uniform1f(u.uScale, cam.scale * dpr);
    gl.uniform3f(u.uF, cam.f[0], cam.f[1], cam.f[2]);
    gl.uniform3f(u.uU, cam.u[0], cam.u[1], cam.u[2]);
    gl.uniform3f(u.uR, cam.r[0], cam.r[1], cam.r[2]);
  }

  attrib(prog, name, size, stride, off) {
    const loc = prog.a[name];
    if (loc === undefined || loc < 0) return;
    const gl = this.gl;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
  }

  detach(prog) {
    for (let i = 0; i < prog.locs.length; i++) this.gl.disableVertexAttribArray(prog.locs[i]);
  }

  fullscreen(prog) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.enableVertexAttribArray(prog.a.aPos);
    gl.vertexAttribPointer(prog.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(prog.a.aPos);
  }

  drawStars(s, M, first, count, starGain, dustGain) {
    const gl = this.gl, P = this.progStar, u = P.u;
    gl.useProgram(P.p);
    this.setCamera(P, s.cam);
    gl.uniformMatrix3fv(u.uM, false, M);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1f(u.uTime, s.time);
    gl.uniform1f(u.uReveal, s.reveal);
    gl.uniform1f(u.uStarGain, starGain);
    gl.uniform1f(u.uDustGain, dustGain);
    gl.uniform1f(u.uSizeGain, s.sizeGain);
    gl.uniform1f(u.uDay, s.day);
    gl.uniform1f(u.uSweep, s.sweep);
    gl.uniform1f(u.uSweepOn, s.sweepOn);
    gl.uniform1f(u.uSel, s.sel);
    gl.uniform1f(u.uMaxPoint, this.maxPoint);
    gl.uniform1f(u.uTwinkle, s.twinkle);
    gl.uniform1f(u.uTerrainH, this.terrainH);
    gl.uniform1f(u.uDeep, this.preserve ? 1 : smooth01((performance.now() - this.deepT0) / 1800));
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    this.attrib(P, 'aPos', 3, 40, 0);
    this.attrib(P, 'aColor', 3, 40, 12);
    this.attrib(P, 'aInfo', 4, 40, 24);
    gl.drawArrays(gl.POINTS, first, count);
    this.detach(P);
  }

  /**
   * Streaks between consecutive sky rotations; the first one joins on to the previous frame. Each
   * sub-step is pre-faded by the part of this frame's fade still ahead of it, so the exposure decays
   * smoothly along the trail even when a slow frame covers many degrees; and a new exposure ramps in
   * over its first degrees, so trails start with a soft taper, not a blob.
   */
  drawTrails(s, Ms, gain, keep, lim) {
    const gl = this.gl, P = this.progTrail, u = P.u;
    gl.useProgram(P.p);
    this.setCamera(P, s.cam);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1f(u.uSizeGain, s.sizeGain);
    gl.uniform1f(u.uTerrainH, this.terrainH);
    gl.uniform1f(u.uTrailLim, lim);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.trailIdx);
    this.attrib(P, 'aPos', 3, 36, 0);
    this.attrib(P, 'aColor', 3, 36, 12);
    this.attrib(P, 'aInfo', 3, 36, 24);
    const n = Ms.length;
    for (let i = 0; i < n; i++) {
      const M = Ms[i];
      if (this.hasPrevM) {
        this.trailDeg += rotationDeg(this.prevM, M);
        const ramp = smooth01(this.trailDeg / TRAIL_RAMP);
        gl.uniform1f(u.uGain, gain * ramp * Math.pow(keep, (n - 1 - i) / n));
        gl.uniformMatrix3fv(u.uMa, false, this.prevM);
        gl.uniformMatrix3fv(u.uMb, false, M);
        gl.drawElements(gl.TRIANGLES, this.trailCount * 6, gl.UNSIGNED_SHORT, 0);
      }
      this.prevM.set(M);
      this.hasPrevM = true;
    }
    this.detach(P);
  }

  /** Rough on-screen displacement (CSS px) of the sky caused by camera changes since last frame. */
  cameraMotion(cam) {
    const c = this.camPrev;
    if (!c) return 0;
    const df = Math.acos(Math.max(-1, Math.min(1, cam.f[0] * c[3] + cam.f[1] * c[4] + cam.f[2] * c[5])));
    const du = Math.acos(Math.max(-1, Math.min(1, cam.u[0] * c[6] + cam.u[1] * c[7] + cam.u[2] * c[8])));
    const half = 0.5 * Math.hypot(this.cssW, this.cssH);
    return Math.abs(cam.cx - c[0]) + Math.abs(cam.cy - c[1]) + Math.abs(cam.scale - c[2]) / Math.max(1, cam.scale) * half
      + (df + du) * cam.scale;
  }

  rememberCamera(cam) {
    const c = this.camPrev || (this.camPrev = new Float64Array(9));
    c[0] = cam.cx; c[1] = cam.cy; c[2] = cam.scale;
    c[3] = cam.f[0]; c[4] = cam.f[1]; c[5] = cam.f[2]; c[6] = cam.u[0]; c[7] = cam.u[1]; c[8] = cam.u[2];
  }

  /** Render one frame. `s` is the full visual state (see main.js → frameState). */
  render(s) {
    if (this.lost) return;
    const gl = this.gl;
    if (!this.deepCount && this.catalog.deep) {
      this.uploadPoints();
      this.deepT0 = performance.now();
    }
    const W = this.canvas.width, H = this.canvas.height;
    const trail = s.trail;
    // A whole-sky chart has no landscape: the skyline flattens into a clean horizon circle as the
    // view tilts up into the dome (continuously, with the ground blend).
    this.terrainH = s.terrainH * (1 - Math.min(1, Math.max(0, s.dome)));

    // How much of the picture is a long exposure. Under the trails the Milky Way is dimmed and its
    // resolved grain removed (a real exposure would smear it); eased in time so it never pops.
    const trailTarget = trail && (trail.on || trail.opacity > 0.001) ? Math.min(1, trail.opacity) : 0;
    const dtT = this.lastTime === undefined ? 1 : Math.min(0.25, Math.max(0, s.time - this.lastTime));
    this.lastTime = s.time;
    if (this.trailMix === undefined || this.preserve) this.trailMix = trailTarget;
    else this.trailMix += (trailTarget - this.trailMix) * (1 - Math.exp(-dtT / 0.45));

    if (trail && (trail.on || trail.opacity > 0.001)) {
      this.ensureFbo();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, W, H);
      let keep = 1;
      if (trail.clear) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this.hasPrevM = false;
      } else if (trail.on) {
        gl.enable(gl.BLEND);
        gl.blendEquation(gl.FUNC_REVERSE_SUBTRACT);
        gl.blendFunc(gl.ONE, gl.SRC_ALPHA);
        gl.useProgram(this.progFade.p);
        // Keep each trail to at most ~120° of arc: at full spin the given fade would let every star
        // draw whole overlapping circles and burn the picture white; arcs still read as motion.
        keep = trail.fade;
        const Ms = trail.Ms;
        if (this.hasPrevM && Ms.length) {
          const spin = rotationDeg(this.prevM, Ms[Ms.length - 1]);
          const frames = -1 / Math.log(Math.min(0.9999, Math.max(1e-4, keep)));
          if (spin * frames > TRAIL_ARC) keep = Math.exp(-spin / TRAIL_ARC);
        }
        // the exposure lives in screen space: when the camera itself moves, let old light go faster
        // so it doesn't smear into arcs that no longer match the sky
        keep *= Math.exp(-this.cameraMotion(s.cam) / 14);
        gl.uniform1f(this.progFade.u.uK, keep);
        gl.uniform1f(this.progFade.u.uEps, this.fboFloat ? 0.0004 : 0.75 / 255);
        this.fullscreen(this.progFade);
        gl.blendEquation(gl.FUNC_ADD);
      }
      if (trail.on) {
        if (!this.hasPrevM) this.trailDeg = 0;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        // Trail brightness per pixel no longer depends on the framing, but density does: a small
        // whole-sky chart packs every trail into a few hundred pixels, so it trails fewer, fainter
        // stars and exposes a little less.
        const cssPerRad = s.cam.scale / Math.max(0.1, s.sizeGain);
        const dense = 1 - smooth01((cssPerRad - 90) / 420);
        const lim = TRAIL_MAG - 1.4 * dense;
        this.drawTrails(s, trail.Ms, s.starGain * (trail.gain ?? 0.24) * (1 - 0.35 * dense), keep, lim);
      } else {
        this.hasPrevM = false;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      this.hasPrevM = false;
    }

    this.rememberCamera(s.cam);

    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    const P = this.progSky, u = P.u;
    gl.useProgram(P.p);
    this.setCamera(P, s.cam);
    const M = s.M, mt = this.mt;
    // transpose: NEU → EQJ
    mt[0] = M[0]; mt[1] = M[3]; mt[2] = M[6]; mt[3] = M[1]; mt[4] = M[4]; mt[5] = M[7]; mt[6] = M[2]; mt[7] = M[5]; mt[8] = M[8];
    gl.uniformMatrix3fv(u.uMt, false, mt);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.mwTex); gl.uniform1i(u.uMW, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(u.uNoise, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform3f(u.uSun, s.sun[0], s.sun[1], s.sun[2]);
    gl.uniform3f(u.uMoon, s.moon[0], s.moon[1], s.moon[2]);
    gl.uniform1f(u.uMoonIllum, s.moonIllum);
    gl.uniform1f(u.uDay, s.day);
    gl.uniform1f(u.uTwilight, s.twilight);
    gl.uniform1f(u.uMwAmt, s.mwAmt * (1 - 0.7 * this.trailMix));
    gl.uniform1f(u.uStarGrain, 1 - this.trailMix);
    gl.uniform1f(u.uPr, this.dpr * s.sizeGain);
    gl.uniform3f(u.uBg, s.bg[0], s.bg[1], s.bg[2]);
    gl.uniform1f(u.uDome, s.dome);
    gl.uniform1f(u.uExposure, s.exposure);
    // callers pass film-grain strength; keep only a static 1-LSB dither of it (quiet, no crawl)
    gl.uniform1f(u.uGrain, Math.min(1 / 255, s.grain * 0.3));
    gl.uniform1f(u.uFlash, s.flash);
    gl.uniform1f(u.uVignette, s.vignette * 0.45);
    gl.uniform1f(u.uTerrainH, this.terrainH);
    this.fullscreen(P);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (s.crisp > 0.001) {
      this.drawStars(s, M, 0, this.pointCount, s.starGain * s.crisp, s.dustGain * s.crisp);
    }
    if (trail && trail.opacity > 0.001) {
      gl.useProgram(this.progBlit.p);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
      gl.uniform1i(this.progBlit.u.uTex, 0);
      gl.uniform2f(this.progBlit.u.uRes, W, H);
      gl.uniform1f(this.progBlit.u.uOpacity, trail.opacity);
      this.fullscreen(this.progBlit);
    }
    gl.disable(gl.BLEND);
  }
}
