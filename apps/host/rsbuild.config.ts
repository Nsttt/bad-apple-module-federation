import { pluginModuleFederation } from '@module-federation/rsbuild-plugin';
import { defineConfig } from '@rsbuild/core';
import { pluginReact } from '@rsbuild/plugin-react';
import { withZephyr } from 'zephyr-rsbuild-plugin';

// Docs: https://rsbuild.rs/config/
export default defineConfig({
  server: {
    port: 3000,
  },
  html: {
    template: './public/index.html',
  },
  plugins: [
    pluginReact(),
    pluginModuleFederation({
      name: 'host',
      remotes: {},
      // No shared deps needed: remotes are CSS/DOM-only.
      shared: {},
    }),
    // Must be after Module Federation so Zephyr can extract + rewrite remotes.
    withZephyr(),
  ],
});
