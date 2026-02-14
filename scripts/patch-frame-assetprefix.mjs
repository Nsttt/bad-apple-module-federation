import fs from 'node:fs/promises';
import path from 'node:path';

const getArg = (name) => {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
};

const assetBase = getArg('--asset-base') || 'http://localhost:4173';
const root = path.resolve('apps/frames');

const insertAfter = 'export default defineConfig({\n';

const patchOne = async (dirName) => {
  const filePath = path.join(root, dirName, 'rsbuild.config.mjs');
  let src = await fs.readFile(filePath, 'utf8');

  if (src.includes('assetPrefix:')) return { status: 'skipped', filePath };
  if (!src.includes(insertAfter)) {
    throw new Error(`Unexpected rsbuild config shape: ${filePath}`);
  }

  const block =
    `  output: {\n` +
    `    assetPrefix: '${assetBase}/${dirName}/',\n` +
    `  },\n`;

  src = src.replace(insertAfter, `${insertAfter}${block}`);
  await fs.writeFile(filePath, src, 'utf8');
  return { status: 'patched', filePath };
};

const main = async () => {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const frames = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('frame-'))
    .map((e) => e.name)
    .sort();

  let patched = 0;
  let skipped = 0;

  for (const dirName of frames) {
    const res = await patchOne(dirName);
    if (res.status === 'patched') patched += 1;
    else skipped += 1;
  }

  console.log(
    `assetPrefix patch complete: patched=${patched} skipped=${skipped} assetBase=${assetBase}`,
  );
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

