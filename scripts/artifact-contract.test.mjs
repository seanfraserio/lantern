import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArtifact, declaredTargets } from './artifact-contract.mjs';

test('conditional exports, declarations and binaries are checked', () => {
  const manifest = { main: './dist/index.cjs', types: './dist/index.d.ts',
    bin: { app: './dist/cli.js' }, exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' } } };
  assert.deepEqual(new Set(declaredTargets(manifest)), new Set(['dist/index.cjs', 'dist/index.d.ts', 'dist/cli.js', 'dist/index.js']));
  assert.deepEqual(checkArtifact(manifest, new Set(declaredTargets(manifest))), []);
  assert.match(checkArtifact(manifest, new Set())[0], /Missing declared entry/);
});

test('runtime local dependencies are rejected but build-only dev dependencies are allowed', () => {
  assert.match(checkArtifact({ dependencies: { helper: 'file:../helper' } }, new Set())[0], /Unresolved dependencies/);
  assert.match(checkArtifact({ optionalDependencies: { helper: 'workspace:*' } }, new Set())[0], /Unresolved optionalDependencies/);
  assert.deepEqual(checkArtifact({ devDependencies: { helper: 'file:../helper' } }, new Set()), []);
});

test('a present TypeScript source export is not a distributable entry', () => {
  assert.match(checkArtifact({ exports: './src/index.ts' }, new Set(['src/index.ts']))[0], /uncompiled source/);
  assert.deepEqual(checkArtifact({ exports: { types: './dist/index.d.ts' } }, new Set(['dist/index.d.ts'])), []);
});
