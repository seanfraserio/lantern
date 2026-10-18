import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkArtifact } from './artifact-contract.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stage = mkdtempSync(join(tmpdir(), 'lantern-artifacts-'));
const failures = [];
const packed = new Map();
const execute = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000,
});
const failure = (label, error) => {
  failures.push(label);
  console.error(`FAIL ${label}: ${error.stderr?.toString() || error.message || error}`);
};
const packages = ['sdk', 'ingest', 'proxy', 'evaluator', ...readdirSync(join(root, 'packages/integrations')).map(name => `integrations/${name}`)];

try {
  for (const name of packages) {
    try {
      const directory = join(root, 'packages', name);
      const before = new Set(readdirSync(stage));
      execute('pnpm', ['pack', '--pack-destination', stage], directory);
      const added = readdirSync(stage).filter(file => file.endsWith('.tgz') && !before.has(file));
      if (added.length !== 1) throw new Error(`Expected one new tarball, found ${added.length}`);
      const tarball = join(stage, added[0]);
      const manifest = JSON.parse(execute('tar', ['-xOf', tarball, 'package/package.json'], stage));
      const entries = new Set(execute('tar', ['-tzf', tarball], stage).split('\n').map(path => path.replace(/^package\//, '')));
      const issues = checkArtifact(manifest, entries);
      for (const issue of issues) failure(`${name} artifact contract`, new Error(issue));
      packed.set(name, tarball);
      if (!issues.length) console.log(`PASS packed contract: ${manifest.name}`);
    } catch (error) { failure(`pack ${name}`, error); }
  }

  const sdk = packed.get('sdk');
  if (sdk) {
    const consumer = join(stage, 'consumer');
    // npm installs only actual packed artifacts; it never sees workspace source.
    mkdirSync(consumer, { recursive: true });
    writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'lantern-consumer', private: true, type: 'module' }));
    try {
      const coreTarballs = ['sdk', 'proxy', 'ingest', 'evaluator'].map(name => {
        const tarball = packed.get(name);
        if (!tarball) throw new Error(`Missing core tarball: ${name}`);
        return tarball;
      });
      execute('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...coreTarballs], consumer);
      const source = `import { LanternTracer, ConsoleExporter, type TracerConfig } from '@openlantern-ai/sdk';\nimport { createProxyServer } from '@openlantern-ai/proxy';\nimport { createServer } from '@openlantern-ai/ingest';\nimport { RelevanceScorer } from '@openlantern-ai/evaluator';\nconst config: TracerConfig = { exporter: new ConsoleExporter() };\nconst constructor: typeof LanternTracer = LanternTracer;\nvoid config; void constructor; void createProxyServer; void createServer; void RelevanceScorer;\n`;
      writeFileSync(join(consumer, 'consumer.ts'), source);
      try {
        execute(join(root, 'node_modules/.bin/tsc'), ['--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.ts'], consumer);
        console.log('PASS external core-package TypeScript consumer');
      } catch (error) { failure('external core-package TypeScript consumer', error); }
      for (const format of ['cjs', 'mjs']) {
        const modules = { sdk: 'LanternTracer', proxy: 'createProxyServer', ingest: 'createServer', evaluator: 'RelevanceScorer' };
        const importCode = Object.keys(modules).map(name => format === 'cjs'
          ? `const ${name} = require('@openlantern-ai/${name}');`
          : `import * as ${name} from '@openlantern-ai/${name}';`).join('\n');
        const script = join(consumer, `consumer.${format}`);
        const assertions = Object.entries(modules).map(([name, symbol]) => `if (typeof ${name}.${symbol} !== 'function') throw new Error('${name}.${symbol} export missing');`).join('\n');
        writeFileSync(script, `${importCode}\n${assertions}\n`);
        try {
          execute('node', [script], consumer);
          console.log(`PASS external core-package ${format} runtime imports`);
        } catch (error) { failure(`external core-package ${format} runtime imports`, error); }
      }
    } catch (error) { failure('external SDK installation', error); }
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
if (failures.length) {
  console.error(`${failures.length} artifact validation failure(s)`);
  process.exitCode = 1;
} else console.log('All actual tarball and external-consumer checks passed.');
