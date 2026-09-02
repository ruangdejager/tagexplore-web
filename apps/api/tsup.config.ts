import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  sourcemap: true,
  clean: true,
  // Bundle every npm dependency into one file, so the runtime image needs a
  // single .js and no node_modules at all. That is also why the database is
  // `node:sqlite` rather than a native module — nothing to compile.
  noExternal: [/^(?!node:).*/],
  external: [/^node:/],
  esbuildPlugins: [
    {
      // esbuild strips the `node:` prefix from externals it recognises, which is
      // harmless for `fs` or `path` — Node resolves those bare. It does the same
      // to `node:sqlite`, whose list entry it predates, and a bare `sqlite` is
      // not resolvable at all: the build succeeds and the server then dies on
      // startup with ERR_MODULE_NOT_FOUND. Returning the path unchanged from
      // onResolve keeps the specifier verbatim in the output.
      name: 'preserve-node-protocol',
      setup(build) {
        build.onResolve({ filter: /^node:/ }, (args) => ({ path: args.path, external: true }));
      },
    },
  ],
});
