// Local preview server. Serves src/ (or --root dir) plus /node_modules for the dev import map.
// POST /__save?path=relative/file.png with a data: URL or raw body writes into .cache/ — used for
// grabbing posters and screenshots out of the browser during QA.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const port = +arg('port', 5178);
const webRoot = path.resolve(projectRoot, arg('root', 'src'));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.bin': 'application/octet-stream',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/__save') {
    const rel = (url.searchParams.get('path') || 'shot.png').replace(/\.\.+/g, '');
    const dest = path.join(projectRoot, '.cache', rel);
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const text = body.toString('latin1', 0, 64);
      if (text.startsWith('data:')) body = Buffer.from(body.toString().split(',')[1], 'base64');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      res.writeHead(200, { 'content-type': 'text/plain' }).end(dest);
    });
    return;
  }
  let file;
  if (url.pathname.startsWith('/node_modules/')) file = path.join(projectRoot, decodeURIComponent(url.pathname));
  else file = path.join(webRoot, decodeURIComponent(url.pathname));
  if (!file.startsWith(projectRoot)) return res.writeHead(403).end();
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) return res.writeHead(404).end('not found');
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`birthsky dev → http://127.0.0.1:${port}/ (root ${webRoot})`));
