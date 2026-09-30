// Production build → dist/: one bundled + minified script, hashed CSS/JS, static data and assets.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src');
const dist = path.join(root, 'dist');
const hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 10);

fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(path.join(dist, 'js'), { recursive: true });
fs.mkdirSync(path.join(dist, 'styles'), { recursive: true });

const dataFiles = fs.readdirSync(path.join(src, 'data'));
const dataVersion = hash(Buffer.concat(dataFiles.map((f) => fs.readFileSync(path.join(src, 'data', f)))));

const js = await esbuild.build({
  entryPoints: [path.join(src, 'js/main.js')],
  bundle: true, minify: true, format: 'iife', target: ['es2019', 'safari14', 'chrome79'],
  write: false, legalComments: 'none', define: { __DATA_VERSION__: JSON.stringify(dataVersion) },
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

for (const dir of ['data', 'assets']) fs.cpSync(path.join(src, dir), path.join(dist, dir), { recursive: true });
fs.copyFileSync(path.join(src, 'manifest.webmanifest'), path.join(dist, 'manifest.webmanifest'));
fs.writeFileSync(path.join(dist, '.nojekyll'), '');

const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`dist/js/${jsName} ${kb(path.join(dist, 'js', jsName))}, styles ${kb(path.join(dist, 'styles', cssName))}, data v${dataVersion}`);
