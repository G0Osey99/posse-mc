import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'view/index': 'src/view/index.ts' },
  format: ['esm'],
  dts: true,
  clean: true,
  outDir: 'dist',
  target: 'node22',
  splitting: true,
  sourcemap: true,
  // Every package (and the optional native @napi-rs/canvas) is loaded from node_modules.
  external: [/^[^./]/],
});
