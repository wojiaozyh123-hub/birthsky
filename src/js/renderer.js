// WebGL sky: atmosphere + Milky Way (full-screen pass), stars and star dust (additive point sprites),
// and an accumulation buffer for long-exposure star trails. GLSL ES 1.00 so it runs on WebGL1 and 2.
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
float ridgeNear(float az) {
  float t = az / 6.2831853 + 0.5;
  float h = 0.55 * tpn(t * 9.0, 9.0) + 0.3 * tpn(t * 23.0, 23.0) + 0.15 * tpn(t * 61.0, 61.0);
  return uTerrainH * (h * h * 1.7 - 0.12);
}
float ridgeFar(float az) {
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

const FULLSCREEN_VS = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const SKY_FS = `${PREC}${CAMERA}${TERRAIN}
uniform mat3 uMt;
uniform sampler2D uMW;
uniform sampler2D uNoise;
uniform float uTime;
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

const vec3 G0 = vec3(-0.0548755604, -0.8734370902, -0.4838350155);
const vec3 G1 = vec3(0.4941094279, -0.4448296300, 0.7469822445);
const vec3 G2 = vec3(-0.8676661490, -0.1980763734, 0.4559837762);

void main() {
  vec2 p = (gl_FragCoord.xy - uCenter) / uScale;
  float rho2 = dot(p, p);
  vec3 v = normalize((4.0 * p.x * uR + 4.0 * p.y * uU + (4.0 - rho2) * uF) / (4.0 + rho2));
  float alt = asin(clamp(v.z, -1.0, 1.0));
  float az = atan(v.y, v.x);
  float pxAng = 4.0 / ((4.0 + rho2) * uScale);
  float th = terrain(az);
  float skyMask = smoothstep(-pxAng, pxAng, alt - th);
  float h = clamp(alt / 1.5707963, 0.0, 1.0);

  vec3 col = mix(vec3(0.028, 0.040, 0.080), vec3(0.005, 0.009, 0.024), pow(h, 0.42));
  col += vec3(0.010, 0.026, 0.030) * exp(-max(alt, 0.0) * 12.0);

  vec3 e = uMt * v;
  float ra = atan(e.y, e.x);
  float dec = asin(clamp(e.z, -1.0, 1.0));
  vec2 uv = vec2(fract(ra / 6.2831853), 0.5 - dec / 3.1415927);
  float L = texture2D(uMW, uv).r;
  if (L > 0.004) {
    float n1 = texture2D(uNoise, uv * vec2(8.0, 4.0)).r;
    float n2 = texture2D(uNoise, uv * vec2(30.0, 15.0)).g;
    float lanes = smoothstep(0.5, 0.78, texture2D(uNoise, uv * vec2(14.0, 7.0) + 0.37).b);
    float mw = L * (0.4 + 1.0 * n1) * (0.72 + 0.56 * n2);
    mw *= 1.0 - 0.6 * lanes * smoothstep(0.12, 0.55, L);
    vec3 g = vec3(dot(G0, e), dot(G1, e), dot(G2, e));
    float gl = atan(g.y, g.x);
    float warm = exp(-gl * gl / 0.4) * smoothstep(0.05, 0.6, L);
    vec3 tint = mix(vec3(0.66, 0.74, 1.0), vec3(1.0, 0.86, 0.68), warm);
    col += tint * mw * 0.46 * uMwAmt * smoothstep(-0.02, 0.4, alt) * (1.0 - 0.85 * uDay);
  }

  float angM = acos(clamp(dot(v, uMoon), -1.0, 1.0));
  float moonUp = smoothstep(-0.05, 0.05, uMoon.z);
  col += vec3(0.70, 0.76, 0.92) * uMoonIllum * moonUp * (0.12 * exp(-angM * 18.0) + 0.03 * exp(-angM * 3.0));

  float cs = dot(v, uSun);
  vec3 dusk = mix(vec3(0.045, 0.065, 0.18), vec3(0.98, 0.48, 0.24), exp(-max(alt, 0.0) * 5.0) * pow(0.5 + 0.5 * cs, 2.5));
  col = mix(col, dusk, uTwilight);
  vec3 day = mix(vec3(0.60, 0.75, 0.92), vec3(0.17, 0.37, 0.72), pow(h, 0.5));
  day += vec3(1.0, 0.93, 0.8) * (pow(max(cs, 0.0), 90.0) * 0.9 + pow(max(cs, 0.0), 6.0) * 0.14);
  col = mix(col, day, uDay);

  float below = max(th - alt, 0.0);
  vec3 groundDome = uBg + vec3(0.034, 0.048, 0.092) * exp(-below * 10.0) * (1.0 - uDay * 0.4);
  float nearTop = ridgeNear(az);
  float farMask = step(nearTop, alt);   // on the far ridge, not the near one
  vec3 groundLand = mix(vec3(0.014, 0.018, 0.032), vec3(0.004, 0.005, 0.010), clamp(below * 3.0, 0.0, 1.0));
  groundLand = mix(groundLand, vec3(0.030, 0.040, 0.070) + vec3(0.02, 0.03, 0.05) * exp(-below * 40.0), farMask * (1.0 - uDome));
  groundLand += mix(vec3(0.020, 0.026, 0.050), dusk * 0.10, uTwilight) * exp(-below * 30.0);
  groundLand += day * 0.08 * uDay;
  vec3 ground = mix(groundLand, groundDome, uDome);
  vec3 outc = mix(ground, col, skyMask);
  outc += vec3(0.035, 0.048, 0.085) * exp(-abs(alt - th) * 24.0) * skyMask * (1.0 - uDay);

  vec2 q = gl_FragCoord.xy / uRes - 0.5;
  outc *= 1.0 - uVignette * dot(q, q);
  outc += uFlash * vec3(0.95, 0.88, 0.76) * exp(-rho2 * 0.35);
  float gr = fract(sin(dot(gl_FragCoord.xy + fract(uTime * 0.37) * 97.0, vec2(12.9898, 78.233))) * 43758.5453);
  outc += (gr - 0.5) * uGrain;
  gl_FragColor = vec4(outc * uExposure, 1.0);
}`;

const STAR_VS = `${CAMERA}${TERRAIN}
attribute vec3 aPos;
attribute vec3 aColor;
attribute vec4 aInfo; // mag, seed, kind (0 star / 1 dust), index
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
varying vec3 vCol;
varying float vSpike;
varying float vCore;

void main() {
  vec3 n = uM * aPos;
  float alt = asin(clamp(n.z, -1.0, 1.0));
  float az = atan(n.y, n.x);
  float th = terrain(az);
  float d = dot(n, uF);
  if (alt < th || d < -0.9) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; return; }
  float k = 2.0 / (1.0 + d);
  vec2 p = uCenter + uScale * k * vec2(dot(n, uR), dot(n, uU));
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);

  float mag = aInfo.x;
  float seed = aInfo.y;
  float dust = aInfo.z;
  float ext = 0.25 * (1.0 / max(sin(alt - th + 0.015), 0.04) - 1.0);
  float m = mag + min(ext, 3.5);
  float L = pow(10.0, -0.4 * m);
  float vis = smoothstep(uReveal + 0.7, uReveal - 0.3, mag);
  float lowness = 1.0 - clamp(alt / 1.1, 0.0, 1.0);
  float tw = 1.0 + uTwinkle * (0.07 + 0.32 * lowness) * sin(uTime * (2.1 + seed * 5.3) + seed * 61.0) * sin(uTime * (0.9 + seed * 2.1) + seed * 17.0);

  float since = mod(az - uSweep, 6.2831853);
  float flare = uSweepOn * exp(-since * 5.0) * step(mag, 4.2) * (1.0 - dust);
  float sel = (1.0 - step(0.5, abs(aInfo.w - uSel))) * (1.0 - dust);

  float size;
  float a;
  if (dust > 0.5) {
    size = 2.2;
    a = uDustGain * (0.05 + 0.09 * seed) * clamp(2.2 - (mag - 7.0), 0.4, 1.4);
  } else {
    size = 2.6 + 10.5 * pow(L, 0.34);
    a = clamp(0.16 + 0.84 * pow(L / 0.03, 0.55), 0.0, 1.0);
  }
  size *= uSizeGain * (1.0 + flare * 0.6 + sel * 0.9);
  vSpike = smoothstep(2.0, -0.6, m) * (1.0 - dust);
  float grow = 1.0 + vSpike * 1.8;
  gl_PointSize = min(size * grow * uDpr, uMaxPoint);
  vCore = min(1.0, (size * uDpr) / max(gl_PointSize, 1.0));
  vCol = aColor * a * vis * tw * uStarGain * (1.0 + flare * 1.3 + sel * 1.2) * (1.0 - 0.5 * uDay);
  vCol = mix(vCol, vCol * vec3(1.0, 0.9, 0.72), flare * 0.6);
}`;

const STAR_FS = `${PREC}
varying vec3 vCol;
varying float vSpike;
varying float vCore;
void main() {
  vec2 pc = gl_PointCoord * 2.0 - 1.0;
  float r = length(pc) / vCore;
  float I = exp(-r * r * 9.0) + exp(-r * 3.4) * 0.30;
  if (vSpike > 0.001) {
    vec2 q = abs(pc);
    I += (exp(-q.x * 70.0) * exp(-q.y * 3.2) + exp(-q.y * 70.0) * exp(-q.x * 3.2)) * vSpike * 0.5;
  }
  I *= smoothstep(1.0, 0.72, length(pc));
  gl_FragColor = vec4(vCol * I, 1.0);
}`;

const FADE_FS = `${PREC}
uniform float uK;
void main() { gl_FragColor = vec4(0.0, 0.0, 0.0, uK); }`;

const BLIT_FS = `${PREC}
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uOpacity;
void main() { gl_FragColor = vec4(texture2D(uTex, gl_FragCoord.xy / uRes).rgb * uOpacity, 1.0); }`;

function makeNoise(size = 256) {
  const rnd = mulberry32(11);
  const grids = [4, 8, 16, 32, 64].map((g) => ({ g, a: Float32Array.from({ length: g * g }, rnd) }));
  const vn = ({ g, a }, x, y) => {
    const fx = x * g, fy = y * g, ix = Math.floor(fx), iy = Math.floor(fy);
    let tx = fx - ix, ty = fy - iy;
    tx = tx * tx * (3 - 2 * tx); ty = ty * ty * (3 - 2 * ty);
    const at = (i, j) => a[(((j % g) + g) % g) * g + (((i % g) + g) % g)];
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * tx;
    const bot = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * tx;
    return top + (bot - top) * ty;
  };
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      const n = grids.map((gr) => vn(gr, u, v));
      const o = (y * size + x) * 4;
      data[o] = 255 * (0.5 * n[0] + 0.3 * n[1] + 0.2 * n[2]);
      data[o + 1] = 255 * (0.45 * n[2] + 0.35 * n[3] + 0.2 * n[4]);
      data[o + 2] = 255 * (0.55 * n[1] + 0.3 * n[2] + 0.15 * n[3]);
      data[o + 3] = 255;
    }
  }
  return { size, data };
}

export class SkyRenderer {
  constructor(canvas, catalog, { preserve = false } = {}) {
    this.canvas = canvas;
    this.catalog = catalog;
    this.preserve = preserve;
    this.dpr = 1;
    this.cssW = 1; this.cssH = 1;
    this.lost = false;
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
    this.maxPoint = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE)[1] || 64;

    this.progSky = this.program(FULLSCREEN_VS, SKY_FS);
    this.progStar = this.program(STAR_VS, STAR_FS);
    this.progFade = this.program(FULLSCREEN_VS, FADE_FS);
    this.progBlit = this.program(FULLSCREEN_VS, BLIT_FS);

    this.triBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const { stars, dust } = this.catalog;
    const total = stars.count + dust.count;
    const buf = new Float32Array(total * 10);
    const rnd = mulberry32(3);
    const put = (src, i, o, kind, idx) => {
      buf.set(src.pos.subarray(i * 3, i * 3 + 3), o);
      buf.set(src.color.subarray(i * 3, i * 3 + 3), o + 3);
      buf[o + 6] = src.mag[i]; buf[o + 7] = rnd(); buf[o + 8] = kind; buf[o + 9] = idx;
    };
    for (let i = 0; i < stars.count; i++) put(stars, i, i * 10, 0, i);
    for (let i = 0; i < dust.count; i++) put(dust, i, (stars.count + i) * 10, 1, -1);
    this.starBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf, gl.STATIC_DRAW);
    this.starCount = stars.count;
    this.dustCount = dust.count;
    this.trailCount = stars.mag.findIndex((m) => m > 4.4);
    if (this.trailCount < 0) this.trailCount = stars.count;

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
  }

  texParams(wrapS, wrapT) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
    return { p, u: uniforms, a: attribs };
  }

  resize(cssW, cssH, dpr) {
    this.cssW = cssW; this.cssH = cssH; this.dpr = dpr;
    const w = Math.max(1, Math.round(cssW * dpr)), h = Math.max(1, Math.round(cssH * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w; this.canvas.height = h;
    }
  }

  ensureFbo() {
    const gl = this.gl, w = this.canvas.width, h = this.canvas.height;
    if (this.fbo && this.fboW === w && this.fboH === h) return;
    if (this.fbo) { gl.deleteFramebuffer(this.fbo); gl.deleteTexture(this.fboTex); }
    this.fboTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.texParams(gl.CLAMP_TO_EDGE, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.fboW = w; this.fboH = h;
  }

  setCamera(prog, cam) {
    const gl = this.gl, dpr = this.dpr, u = prog.u;
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter, cam.cx * dpr, (this.cssH - cam.cy) * dpr);
    gl.uniform1f(u.uScale, cam.scale * dpr);
    gl.uniform3fv(u.uF, cam.f);
    gl.uniform3fv(u.uU, cam.u);
    gl.uniform3fv(u.uR, cam.r);
  }

  fullscreen(prog) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.triBuf);
    gl.enableVertexAttribArray(prog.a.aPos);
    gl.vertexAttribPointer(prog.a.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disableVertexAttribArray(prog.a.aPos);
  }

  drawStars(s, M, first, count, overrides = {}) {
    const gl = this.gl, P = this.progStar, u = P.u;
    gl.useProgram(P.p);
    this.setCamera(P, s.cam);
    gl.uniformMatrix3fv(u.uM, false, M);
    gl.uniform1f(u.uDpr, this.dpr);
    gl.uniform1f(u.uTime, s.time);
    gl.uniform1f(u.uReveal, s.reveal);
    gl.uniform1f(u.uStarGain, overrides.starGain ?? s.starGain);
    gl.uniform1f(u.uDustGain, overrides.dustGain ?? s.dustGain);
    gl.uniform1f(u.uSizeGain, s.sizeGain);
    gl.uniform1f(u.uDay, s.day);
    gl.uniform1f(u.uSweep, s.sweep);
    gl.uniform1f(u.uSweepOn, overrides.sweepOn ?? s.sweepOn);
    gl.uniform1f(u.uSel, s.sel);
    gl.uniform1f(u.uMaxPoint, this.maxPoint);
    gl.uniform1f(u.uTwinkle, overrides.twinkle ?? s.twinkle);
    gl.uniform1f(u.uTerrainH, s.terrainH);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
    const stride = 40;
    const bind = (name, size, off) => {
      const loc = P.a[name];
      if (loc === undefined || loc < 0) return;
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off);
    };
    bind('aPos', 3, 0); bind('aColor', 3, 12); bind('aInfo', 4, 24);
    gl.drawArrays(gl.POINTS, first, count);
    for (const name of ['aPos', 'aColor', 'aInfo']) if (P.a[name] >= 0) gl.disableVertexAttribArray(P.a[name]);
  }

  /** Render one frame. `s` is the full visual state (see main.js → frameState). */
  render(s) {
    if (this.lost) return;
    const gl = this.gl;
    const W = this.canvas.width, H = this.canvas.height;
    const trail = s.trail;

    if (trail && (trail.on || trail.opacity > 0.001)) {
      this.ensureFbo();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
      gl.viewport(0, 0, W, H);
      if (trail.clear) {
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else if (trail.on) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ZERO, gl.SRC_ALPHA);
        gl.useProgram(this.progFade.p);
        gl.uniform1f(this.progFade.u.uK, trail.fade);
        this.fullscreen(this.progFade);
      }
      if (trail.on) {
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        const gain = s.starGain * (trail.gain ?? 0.55);
        for (const M of trail.Ms) this.drawStars(s, M, 0, this.trailCount, { starGain: gain, sweepOn: 0, twinkle: 0 });
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    const P = this.progSky, u = P.u;
    gl.useProgram(P.p);
    this.setCamera(P, s.cam);
    const M = s.M;
    // transpose: NEU → EQJ
    gl.uniformMatrix3fv(u.uMt, false, [M[0], M[3], M[6], M[1], M[4], M[7], M[2], M[5], M[8]]);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.mwTex); gl.uniform1i(u.uMW, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.noiseTex); gl.uniform1i(u.uNoise, 1);
    gl.uniform1f(u.uTime, s.time);
    gl.uniform3fv(u.uSun, s.sun);
    gl.uniform3fv(u.uMoon, s.moon);
    gl.uniform1f(u.uMoonIllum, s.moonIllum);
    gl.uniform1f(u.uDay, s.day);
    gl.uniform1f(u.uTwilight, s.twilight);
    gl.uniform1f(u.uMwAmt, s.mwAmt);
    gl.uniform3fv(u.uBg, s.bg);
    gl.uniform1f(u.uDome, s.dome);
    gl.uniform1f(u.uExposure, s.exposure);
    gl.uniform1f(u.uGrain, s.grain);
    gl.uniform1f(u.uFlash, s.flash);
    gl.uniform1f(u.uVignette, s.vignette);
    gl.uniform1f(u.uTerrainH, s.terrainH);
    this.fullscreen(P);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    if (s.crisp > 0.001) {
      this.drawStars(s, M, 0, this.starCount + this.dustCount, { starGain: s.starGain * s.crisp, dustGain: s.dustGain * s.crisp });
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
