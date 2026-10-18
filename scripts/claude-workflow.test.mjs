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

test('agent reviews explicitly allow only review read and comment tools', () => {
  const review = workflow.split('  claude-review:')[1] ?? '';
  assert.match(review, /claude_args: \|/);
  assert.match(review, /--allowedTools "mcp__github_inline_comment__create_inline_comment,Bash\(gh pr comment:\*\),Bash\(gh pr diff:\*\),Bash\(gh pr view:\*\)"/);
  assert.doesNotMatch(review, /--dangerously-skip-permissions|--permission-mode bypassPermissions/);
});

test('agent review receives exact PR context and posts a verifiable summary', () => {
  const review = workflow.split('  claude-review:')[1] ?? '';
  for (const expression of ['github.repository', 'github.event.pull_request.number', 'github.event.pull_request.head.sha']) {
    assert.ok(review.includes('${{ ' + expression + ' }}'), `missing ${expression}`);
  }
  assert.match(review, /Always post a summary using `gh pr comment/);
});

test('automatic reviews run for the current PR head', () => {
  assert.match(workflow, /pull_request:\n    types: \[opened, synchronize, reopened\]/);
});
test('integration does not broaden access to untrusted actors or privileged PR events', () => {
  assert.doesNotMatch(workflow, /pull_request_target|allowed_non_write_users|allowed_bots/);
});
