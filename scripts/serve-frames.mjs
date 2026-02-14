import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs/promises';

const port = Number(process.env.PORT || 4173);
const root = path.resolve('apps/frames');
const logRequests = process.env.LOG === '1';

const mime = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);

    if (parts.length === 0) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('Bad Apple frame server. Use /frame-0001/mf-manifest.json');
      if (logRequests) console.log(`${req.method} ${url.pathname} 200`);
      return;
    }

    const frameName = parts.shift();
    let rest = parts.join('/');
    if (!rest || rest.endsWith('/')) {
      rest = 'mf-manifest.json';
    }

    const filePath = path.join(root, frameName, 'dist', rest);
    const data = await fs.readFile(filePath);
    const ext = path.extname(filePath);

    res.writeHead(200, {
      'content-type': mime[ext] || 'application/octet-stream',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end(data);
    if (logRequests) console.log(`${req.method} ${url.pathname} 200`);
  } catch (err) {
    res.writeHead(404, {
      'content-type': 'text/plain',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
    });
    res.end('Not found');
    try {
      if (logRequests && req?.url) console.log(`${req.method} ${req.url} 404`);
    } catch {}
  }
});

server.listen(port, () => {
  console.log(`Frame server on http://localhost:${port}`);
});
