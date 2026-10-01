// Production build → dist/: one bundled + minified script, hashed CSS/JS, static data and assets.
//   node tools/build.mjs            checks, then build (style checks only warn)
//   STRICT=1 node tools/build.mjs   style checks fail the build too
//   node tools/build.mjs --check    run the checks only, build nothing
//
// Checks (run before dist/ is touched, so a failed build keeps the previous dist):
//   glyphs  every character of DISPLAY_STRINGS (src/js/copy.js) exists in nawan-serif-400.woff2, and the
//           figures of cormorant-lining-500.woff2 are complete (spec D-8, D-9). Always fatal: regenerate
//           the fonts with tools/subset-fonts.py.
//   style   no 'backdrop-filter' or 'infinite' in src/styles/main.css, no <em> in src/js/*.js or
//           src/index.html (spec §1.5, §2.4, §8). Fatal only with STRICT=1 until the new shell lands.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import * as fontkit from 'fontkit';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);
const rel = (f) => path.relative(root, f);
const STRICT = process.env.STRICT === '1';
// 印成明信片: business/config-for-web.json (written by the business side) → CONFIG.print at build time
function businessJson() {
  try { return JSON.parse(fs.readFileSync(path.join(root, 'business/config-for-web.json'), 'utf8')); } catch { return {}; }
}
function printConfig() {
  const j = businessJson();
  const pick = (k) => (typeof j[k] === 'string' ? j[k].trim() : undefined);
  const out = Object.fromEntries(['price', 'shopUrl', 'contact', 'email'].map((k) => [k, pick(k)]).filter(([, v]) => v !== undefined && v !== ''));
  if (typeof j.printEnabled === 'boolean') out.enabled = j.printEnabled;
  return out;
}
// 赞助与合作 row + the tip (收款码) on the ground; the image is copied into dist/assets only when it exists
const TIP_SRC = path.join(root, 'business/assets/tip-qr.png');
function siteConfig() {
  const j = businessJson();
  const str = (x) => (typeof x === 'string' ? x.trim() : '');
  const sp = j.sponsor || {}, tip = j.tip || {};
  return {
    sponsor: sp.enabled ? { tag: str(sp.tag) || '赞助', title: str(sp.title), text: str(sp.text), url: str(sp.url) } : null,
    tip: tip.enabled && fs.existsSync(TIP_SRC) ? { image: 'assets/tip-qr.png', line: str(tip.line), hint: str(tip.hint) } : null,
    // 百度统计: on only with a real 32-hex site id; otherwise off (and the privacy line stays out)
    // 不蒜子: no account, counts page views by Referer (so never set no-referrer on the page)
    analytics: (j.analytics?.provider === 'baidu' && /^[0-9a-f]{32}$/i.test(str(j.analytics?.baidu?.id)))
      ? { provider: 'baidu', baidu: { id: str(j.analytics.baidu.id) }, umami: { src: '', websiteId: '' } }
      : j.analytics?.provider === 'busuanzi' ? { provider: 'busuanzi', baidu: { id: '' }, umami: { src: '', websiteId: '' } } : null,
  };
}
const CHECK_ONLY = process.argv.includes('--check');

// ------------------------------------------------------------------------------------------ checks
// spec §2.1; used only when copy.js does not exist yet or exports no DISPLAY_STRINGS
const SPEC_DISPLAY_STRINGS = ['你来的那晚', '这是你来的那晚', '两个人的星空', '你是哪一天来到这个世界的？',
  'TA 是哪一天出生的？', '用这个生日吗？', '那一夜', '关于'];
const NUM_CHARS = '0123456789.:·- ';
const FONTS = { display: 'src/assets/fonts/nawan-serif-400.woff2', num: 'src/assets/fonts/cormorant-lining-500.woff2' };
const DISPLAY_BUDGET = { target: 24 * 1024, limit: 30 * 1024 };

async function displayStrings() {
  const file = path.join(src, 'js/copy.js');
  if (!fs.existsSync(file)) return { list: SPEC_DISPLAY_STRINGS, from: 'spec §2.1 (src/js/copy.js not found)' };
  try {
    const mod = await import(pathToFileURL(file).href);
    if (Array.isArray(mod.DISPLAY_STRINGS) && mod.DISPLAY_STRINGS.length) return { list: mod.DISPLAY_STRINGS.map(String), from: rel(file) };
  } catch (e) {
    // copy.js may touch the DOM at import time; fall back to reading the array literal
    const m = fs.readFileSync(file, 'utf8').match(/export\s+const\s+DISPLAY_STRINGS\s*=\s*(?:Object\.freeze\(\s*)?\[([\s\S]*?)\]/);
    if (m) {
      const list = [...m[1].matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)].map((q) => q[1] ?? q[2] ?? q[3]);
      if (list.length) return { list, from: `${rel(file)} (literal; import failed: ${e.message})` };
    }
  }
  return { list: SPEC_DISPLAY_STRINGS, from: `spec §2.1 (no DISPLAY_STRINGS export in ${rel(file)})` };
}

function coverage(fontFile, chars) {
  const file = path.join(root, fontFile);
  if (!fs.existsSync(file)) return { missing: [...new Set(chars)], size: 0, family: '(missing file)' };
  const font = fontkit.openSync(file);
  const missing = [...new Set(chars)].filter((c) => !font.hasGlyphForCodePoint(c.codePointAt(0)));
  return { missing, size: fs.statSync(file).size, family: font.familyName };
}

// comment lines (// …, /* …, * …, <!-- …) may name the banned things; only code counts
const isComment = (line) => /^\s*(\/\/|\/\*|\*|<!--)/.test(line);
function grepLines(file, re) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .flatMap((line, i) => (re.test(line) && !isComment(line) ? [`${rel(file)}:${i + 1}: ${line.trim().slice(0, 110)}`] : []));
}

async function runChecks() {
  const fatal = [], style = [], notes = [];
  const kb = (n) => `${(n / 1024).toFixed(1)} KB`;

  // glyph coverage (always fatal)
  const { list, from } = await displayStrings();
  const chars = [...new Set([...list.join('')])].filter((c) => c.trim());
  const d = coverage(FONTS.display, chars);
  if (d.missing.length) {
    const users = list.filter((s) => d.missing.some((c) => s.includes(c)));
    fatal.push(`glyphs  ${FONTS.display} lacks ${d.missing.map((c) => `「${c}」`).join('')} used by ${users.map((s) => `「${s}」`).join(' ')}. `
      + 'Add the string to DISPLAY_STRINGS and run tools/subset-fonts.py, or set that text in --f-text.');
  } else notes.push(`glyphs  ${list.length} display strings from ${from}: ${chars.length} characters, all in ${d.family} (${kb(d.size)})`);
  if (d.size > DISPLAY_BUDGET.limit) fatal.push(`glyphs  ${FONTS.display} is ${kb(d.size)}, over the ${kb(DISPLAY_BUDGET.limit)} limit (spec D-9)`);
  else if (d.size > DISPLAY_BUDGET.target) notes.push(`glyphs  note: ${FONTS.display} is ${kb(d.size)}, over the ${kb(DISPLAY_BUDGET.target)} target`);
  const n = coverage(FONTS.num, [...NUM_CHARS]);
  if (n.missing.length) fatal.push(`glyphs  ${FONTS.num} lacks ${n.missing.map((c) => JSON.stringify(c)).join(' ')}`);
  else notes.push(`glyphs  ${n.family} covers 0-9 . : · - space (${kb(n.size)})`);

  // style rules (fatal with STRICT=1)
  const css = path.join(src, 'styles/main.css');
  style.push(...grepLines(css, /backdrop-filter/i).map((l) => `style   backdrop-filter  ${l}`));
  style.push(...grepLines(css, /infinite/i).map((l) => `style   infinite         ${l}`));
  const jsFiles = fs.readdirSync(path.join(src, 'js')).filter((f) => f.endsWith('.js')).map((f) => path.join(src, 'js', f));
  for (const f of [...jsFiles, path.join(src, 'index.html')]) style.push(...grepLines(f, /<\/?em[\s>]/i).map((l) => `style   <em>             ${l}`));
  if (!style.length) notes.push('style   no backdrop-filter / infinite in main.css, no <em> in src/js or index.html');

  console.log('checks');
  for (const l of notes) console.log(`  ok    ${l}`);
  for (const l of fatal) console.log(`  FAIL  ${l}`);
  for (const l of style) console.log(`  ${STRICT ? 'FAIL' : 'warn'}  ${l}`);
  if (style.length && !STRICT) console.log(`  (${style.length} style finding${style.length > 1 ? 's' : ''}; STRICT=1 makes them fatal)`);
  return fatal.length === 0 && (!STRICT || style.length === 0);
}

if (!(await runChecks())) {
  console.error('build stopped by failed checks');
  process.exit(1);
}
if (CHECK_ONLY) process.exit(0);

// ------------------------------------------------------------------------------------------ build
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
fs.mkdirSync(path.join(dist, 'styles'), { recursive: true });

const dataFiles = fs.readdirSync(path.join(src, 'data'));
const dataVersion = hash(Buffer.concat(dataFiles.map((f) => fs.readFileSync(path.join(src, 'data', f)))));

const js = await esbuild.build({
  entryPoints: [path.join(src, 'js/main.js')],
  bundle: true, minify: true, format: 'iife', target: ['es2019', 'safari14', 'chrome79'],
  write: false, legalComments: 'none', define: { __DATA_VERSION__: JSON.stringify(dataVersion), __PRINT_CONFIG__: JSON.stringify(printConfig()), __SITE_CONFIG__: JSON.stringify(siteConfig()) },
});
const jsCode = js.outputFiles[0].contents;
const jsName = `app.${hash(jsCode)}.js`;
fs.writeFileSync(path.join(dist, 'js', jsName), jsCode);

const css = await esbuild.transform(fs.readFileSync(path.join(src, 'styles/main.css'), 'utf8'), { loader: 'css', minify: true, target: ['safari14', 'chrome79'] });
const cssName = `main.${hash(css.code)}.css`;
fs.writeFileSync(path.join(dist, 'styles', cssName), css.code);

let html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
html = html.replace(/<!--dev:start-->[\s\S]*?<!--dev:end-->\n?/, '')
  .replace('href="styles/main.css"', `href="styles/${cssName}"`)
  .replace('<script type="module" src="js/main.js"></script>', `<script src="js/${jsName}" defer></script>`);
fs.writeFileSync(path.join(dist, 'index.html'), html);

// src/dev/ (test pages) is never shipped; fonts ship from assets/fonts as they are
for (const dir of ['data', 'assets']) fs.cpSync(path.join(src, dir), path.join(dist, dir), { recursive: true });
if (siteConfig().tip) fs.copyFileSync(TIP_SRC, path.join(dist, 'assets/tip-qr.png'));
fs.copyFileSync(path.join(src, 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

const size = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`dist/js/${jsName} ${size(path.join(dist, 'js', jsName))}, styles ${size(path.join(dist, 'styles', cssName))}, data v${dataVersion}`);
