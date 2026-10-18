import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/claude.yml', import.meta.url), 'utf8');
for (const job of ['claude-respond', 'claude-review']) {
  test(`${job}: explicit repository token replaces app/OIDC authentication`, () => {
    const block = workflow.split(`  ${job}:`)[1]?.split(/\n  [a-z][a-z-]+:/)[0] ?? '';
    assert.match(block, /github_token: \$\{\{ github\.token \}\}/);
    assert.match(block, /anthropic_api_key: \$\{\{ secrets\.ANTHROPIC_API_KEY \}\}/);
    assert.match(block, /bot_name: "github-actions\[bot\]"/);
    assert.match(block, /bot_id: "41898282"/);
    assert.match(block, /contents: read/);
    assert.doesNotMatch(block, /contents: write|id-token: write/);
  });
}
test('automatic reviews run for the current PR head', () => {
  assert.match(workflow, /pull_request:\n    types: \[opened, synchronize, reopened\]/);
});
test('integration does not broaden access to untrusted actors or privileged PR events', () => {
  assert.doesNotMatch(workflow, /pull_request_target|allowed_non_write_users|allowed_bots/);
});
