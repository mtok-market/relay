// build-relay-bundle.mjs (synced) — bundle the relay into one standalone CLI
// for npx mtok-relay. mtok-relay.mjs imports ./lib.mjs + ./core/onchain.js + viem;
// esbuild inlines all of it (node:* stays external). Output: dist/mtok-relay.mjs.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { chmodSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const require = createRequire(path.join(root, 'package.json')); // esbuild is a devDependency here
const { build } = require('esbuild');

const outfile = path.join(root, 'dist/mtok-relay.mjs');
await build({
  entryPoints: [path.join(root, 'mtok-relay.mjs')],
  outfile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  legalComments: 'none',
  banner: { js: '// GENERATED from mtok-relay.mjs — do not edit by hand.' },
});
chmodSync(outfile, 0o755);
console.log('wrote dist/mtok-relay.mjs');
