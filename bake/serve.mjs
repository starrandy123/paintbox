// A tiny local server for the bake and the game: serves the project folder on 127.0.0.1 and saves what a page PUTs to /save/<name>.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.bin': 'application/octet-stream', '.png': 'image/png', '.css': 'text/css', '.wasm': 'application/wasm' };

// a windowless Chromium that draws on this machine's GPU (Metal on a Mac)
export const GPU_ARGS = ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : [])];

export function serve(port = 0, saveDir = path.join(ROOT, 'data')) {
  fs.mkdirSync(saveDir, { recursive: true });
  const server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    if (req.method === 'PUT' && url.startsWith('/save/')) {
      const name = url.slice(6);
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) { res.writeHead(400); res.end('bad name'); return; }
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { fs.writeFileSync(path.join(saveDir, name), Buffer.concat(chunks)); res.writeHead(200); res.end('saved'); });
      return;
    }
    const file = path.join(ROOT, path.normalize(url).replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(port, '127.0.0.1', () => ok({ server, port: server.address().port, root: ROOT })));
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const { port } = await serve(Number(process.argv[2] || 8737));
  console.log(`serving ${ROOT} on http://127.0.0.1:${port}/`);
}
