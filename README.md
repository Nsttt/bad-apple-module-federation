# Bad Apple MF

Monorepo with one host and many module federation remotes (one per frame). Remotes export HTML + CSS payloads and are loaded at runtime.

## Quick start

```sh
pnpm install
pnpm frames:generate --frames=120 --width=320 --height=240
pnpm frames:build
pnpm frames:serve
pnpm host:dev
```

Open `http://localhost:3000`.

## PNG frames -> CSS (node)

```sh
pnpm frames:generate \
  --frames-dir=./frames \
  --frames=5258 \
  --width=480 \
  --height=360 \
  --pixel=6 \
  --threshold=140
```

Notes:
- `--pixel` controls downscale (bigger = fewer points, lighter CSS).
- Or specify `--cols` / `--rows` directly.
- Keep host `frameWidth`/`frameHeight` aligned with `--width`/`--height`.

## Config

- Host runtime config: `apps/host/src/App.tsx` (or set `window.__BAD_APPLE__` before boot)
- Frame generator: `scripts/generate-frames.mjs`
- Frame remotes: `apps/frames/frame-0001` etc

## Notes

- `scripts/serve-frames.mjs` serves `apps/frames/*/dist` with CORS for the host runtime.
- Frame remotes use `mf-manifest.json` via `@module-federation/rsbuild-plugin`.
- Placeholder CSS uses gradients; PNG mode uses box-shadow pixels.
