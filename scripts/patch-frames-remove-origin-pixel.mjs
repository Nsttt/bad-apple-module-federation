import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('apps/frames');

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

async function main() {
  if (!(await exists(root))) {
    console.log(`no frames dir at ${root} (nothing to patch)`);
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true });
  const frames = entries
    .filter((e) => e.isDirectory() && /^frame-[0-9]{4}$/.test(e.name))
    .map((e) => e.name)
    .sort();

  let patched = 0;
  let scanned = 0;

  for (const frameDir of frames) {
    const filePath = path.join(root, frameDir, 'src', 'frame.js');
    if (!(await exists(filePath))) continue;
    scanned += 1;

    const before = await fs.readFile(filePath, 'utf8');
    // Generated CSS includes `.pixel { ... background: #111; }` which renders an
    // unwanted dot at (0,0). Make the origin element transparent; pixels remain
    // rendered via box-shadow entries.
    //
    // `frame.js` embeds CSS as a JS string containing literal `\\n` sequences.
    // Simple string replacement is safest and avoids touching box-shadow data.
    const after = before.replaceAll('background: #111;', 'background: transparent;');

    if (after !== before) {
      await fs.writeFile(filePath, after, 'utf8');
      patched += 1;
    }
  }

  console.log(
    `patch-origin-pixel complete: scanned=${scanned} patched=${patched}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
