import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const framesRoot = path.join(root, 'apps', 'frames');

const exists = async (p) => {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
};

if (!(await exists(framesRoot))) {
  console.error(`missing: ${framesRoot}`);
  process.exit(1);
}

const entries = await fs.readdir(framesRoot, { withFileTypes: true });
const frameDirs = entries
  .filter((e) => e.isDirectory() && e.name.startsWith('frame-'))
  .map((e) => e.name)
  .sort();

let patched = 0;
let skipped = 0;
let missing = 0;

for (const dir of frameDirs) {
  const cfgPath = path.join(framesRoot, dir, 'rsbuild.config.mjs');
  if (!(await exists(cfgPath))) {
    missing += 1;
    continue;
  }

  const src = await fs.readFile(cfgPath, 'utf8');
  if (src.includes('externalRuntime: true')) {
    skipped += 1;
    continue;
  }

  // Simple, stable transform: insert experiments block after `shared: {},`
  const needle = '      shared: {},\n';
  if (!src.includes(needle)) {
    skipped += 1;
    continue;
  }

  const next =
    src.replace(
      needle,
      `${needle}      experiments: {\n        // Use the host's MF runtime (see host: provideExternalRuntime).\n        externalRuntime: true,\n      },\n`,
    );

  await fs.writeFile(cfgPath, next, 'utf8');
  patched += 1;
}

console.log(
  JSON.stringify(
    { patched, skipped, missing, frames: frameDirs.length },
    null,
    2,
  ),
);

