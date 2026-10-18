import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = path => JSON.parse(readFileSync(join(root, path), 'utf8'));
function manifests(directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (['node_modules', '.git', 'dist', '.turbo', 'sdk-python'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    return entry.isDirectory() ? manifests(path) : entry.name === 'package.json' ? [path] : [];
  });
}

test('every workspace Vitest declaration uses the patched compatible release', () => {
  let count = 0;
  for (const path of manifests()) {
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    for (const section of ['dependencies', 'devDependencies', 'peerDependencies']) {
      if (manifest[section]?.vitest) {
        count++;
        assert.equal(manifest[section].vitest, '^4.1.11', path);
      }
    }
  }
  assert.ok(count >= 10, 'all existing workspace test runners remain declared');
  assert.equal(read('package.json').devDependencies['@vitest/coverage-v8'], '^4.1.11');
});

test('build and lint tools stay on patched Node 20 compatible majors', () => {
  const manifest = read('package.json');
  assert.equal(manifest.devDependencies.vite, '^7.3.7');
  assert.equal(manifest.devDependencies.eslint, '^10.13.0');
  assert.equal(manifest.devDependencies['@typescript-eslint/parser'], '^8.71.2');
  assert.equal(manifest.devDependencies['@typescript-eslint/eslint-plugin'], '^8.71.2');
  for (const path of manifests()) {
    const packageJson = JSON.parse(readFileSync(path, 'utf8'));
    if (packageJson.devDependencies?.tsup) assert.equal(packageJson.devDependencies.tsup, '^8.5.1', path);
    if (!packageJson.private && packageJson.engines?.node) assert.equal(packageJson.engines.node, '>=20.0.0', path);
  }
  assert.ok(!Object.keys(manifest.pnpm.overrides).some(key => /^(vitest|vite|esbuild|@opentelemetry\/core)$/.test(key)));
});

test('CI fails on high or critical development advisories', () => {
  const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /name: Security audit\s+run: pnpm audit --audit-level=high\s*\n/);
  assert.doesNotMatch(ci, /pnpm audit[^\n]*\|\|/);
});
