import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';

const args = new Map();
for (const part of process.argv.slice(2)) {
  const [key, value] = part.split('=');
  if (key?.startsWith('--')) args.set(key.slice(2), value ?? true);
}

const toInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const startIndex = Math.max(1, toInt(args.get('start'), 1));
const concurrency = Math.max(1, Math.min(32, toInt(args.get('concurrency'), 8)));
const silent = args.get('silent') === '1' || args.get('silent') === true;

const findMaxFromFramesDir = async () => {
  try {
    const files = await fs.readdir('frames');
    let max = 0;
    for (const f of files) {
      const m = f.match(/^frame(\d+)\.png$/i);
      if (!m) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
    return max || null;
  } catch {
    return null;
  }
};

const endIndex =
  Math.max(startIndex, toInt(args.get('end'), 0)) ||
  (await findMaxFromFramesDir()) ||
  0;

if (!endIndex) {
  console.error('Missing --end=... and could not infer from ./frames');
  process.exit(1);
}

const pad4 = (n) => String(n).padStart(4, '0');

const runOne = (id) =>
  new Promise((resolve) => {
    const pkg = `@bad-apple/frame-${id}`;
    const child = spawn('pnpm', ['--filter', pkg, 'build'], {
      stdio: silent ? ['ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let errTail = '';
    child.stderr?.on('data', (buf) => {
      const s = String(buf);
      errTail = (errTail + s).slice(-4000);
    });

    child.on('close', (code) => {
      if (code === 0) return resolve({ ok: true, id });
      resolve({ ok: false, id, errTail });
    });
  });

const ids = [];
for (let i = startIndex; i <= endIndex; i += 1) ids.push(pad4(i));

let done = 0;
let ok = 0;
let failed = 0;
const t0 = Date.now();

const logProgress = () => {
  const dt = Math.max(1, (Date.now() - t0) / 1000);
  const rate = done / dt;
  const remaining = ids.length - done;
  const eta = rate > 0 ? Math.round(remaining / rate) : 0;
  process.stdout.write(
    `\rframes build: done=${done}/${ids.length} ok=${ok} failed=${failed} rate=${rate.toFixed(
      1,
    )}/s eta=${eta}s   `,
  );
};

const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
  while (ids.length) {
    const id = ids.shift();
    if (!id) return;
    const res = await runOne(id);
    done += 1;
    if (res.ok) ok += 1;
    else {
      failed += 1;
      process.stdout.write('\n');
      console.error(`build failed: frame-${id}`);
      if (res.errTail) console.error(res.errTail.trim());
      process.exitCode = 1;
      return;
    }
    if (!silent && done % 25 === 0) process.stdout.write('\n');
    logProgress();
  }
});

logProgress();
await Promise.all(workers);
process.stdout.write('\n');

if (failed) process.exit(1);

