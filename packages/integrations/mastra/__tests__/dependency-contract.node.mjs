import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const integrations = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("security overrides do not replace unrelated dependency majors", () => {
  const manifest = JSON.parse(readFileSync(join(integrations, "../../package.json"), "utf8"));
  const overrides = manifest.pnpm.overrides;
  for (const name of ["picomatch", "undici", "cookie", "path-to-regexp", "dotenv-expand"]) {
    assert.equal(overrides[name], undefined, `${name} must not have a global cross-major override`);
  }
  assert.equal(overrides["flatted"], ">=3.4.2 <4");
  assert.equal(overrides["express>body-parser"], undefined,
    "Express 4 requires body-parser 1, so a body-parser 2 override must target Express 5 only");
  assert.equal(overrides["express@5>body-parser"], "2.3.0");
});

for (const [directory, framework, factory] of [
  ["mastra", "mastra", "createLanternMastraHook"],
  ["openai-agents", "@openai/agents", "createLanternTraceProcessor"],
  ["bedrock", "@aws-sdk/client-bedrock-runtime", "wrapBedrockClient"],
  ["cohere", "cohere-ai", "wrapCohereClient"],
  ["mistral", "@mistralai/mistralai", "wrapMistralClient"],
]) {
  test(`${directory}: packed structural callbacks need no framework installation`, () => {
    const cwd = join(integrations, directory);
    const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      assert.equal(manifest[section]?.[framework], undefined,
        `${framework} is not imported at runtime or in public types; it must not be auto-installed`);
    }
    const scratch = mkdtempSync(join(tmpdir(), "lantern-callback-contract-"));
    try {
      execFileSync("pnpm", ["build"], { cwd, stdio: "pipe" });
      execFileSync("pnpm", ["pack", "--pack-destination", scratch], { cwd, stdio: "pipe" });
      const archive = readdirSync(scratch).find((file) => file.endsWith(".tgz"));
      assert.ok(archive, "pnpm pack produced a real package");
      execFileSync("tar", ["-xzf", join(scratch, archive), "-C", scratch]);
      const dist = join(scratch, "package", "dist");
      for (const declaration of ["index.d.ts", "index.d.cts"]) {
        assert.doesNotMatch(readFileSync(join(dist, declaration), "utf8"),
          /from\s+["'](?:mastra|cohere-ai|@mastra\/[^"']+|@openai\/[^"']+|@aws-sdk\/[^"']+|@mistralai\/[^"']+)["']/);
      }
      // The extracted package has no node_modules and is outside the workspace.
      // Exercise both published entry points, not Vitest's source aliases.
      for (const [mode, entry] of [["module", "index.js"], ["commonjs", "index.cjs"]]) {
        const load = mode === "module"
          ? `import * as integration from ${JSON.stringify(join(dist, entry))};`
          : `const integration = require(${JSON.stringify(join(dist, entry))});`;
        const exercise = directory === "mastra"
          ? `hook.onSpanStart({ spanId: "s", name: "llm.generate" });
             hook.onSpanEnd({ spanId: "s" }); hook.finish();`
          : directory === "openai-agents" ? `hook.onTraceStart({ traceId: "t" });
             hook.onSpanStart({ traceId: "t", spanId: "s", type: "generation" });
             hook.onSpanEnd({ traceId: "t", spanId: "s" });
             hook.onTraceEnd({ traceId: "t" });`
          : directory === "bedrock" ? `class ConverseCommand { input = { modelId: "example", messages: [] }; }
             const client = { send: async () => ({ usage: {}, output: {} }) };
             await integration.wrapBedrockClient(client, tracer).send(new ConverseCommand());`
          : directory === "cohere" ? `const client = { chat: async () => ({ text: "ok" }), generate: async () => ({ generations: [] }) };
             await integration.wrapCohereClient(client, tracer).chat({ message: "example" });`
          : `const client = { chat: { complete: async () => ({ choices: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } }) } };
             await integration.wrapMistralClient(client, tracer).chat.complete({ model: "example", messages: [] });`;
        execFileSync(process.execPath, [`--input-type=${mode}`, "-e", `
          ${load}
          (async () => {
          const calls = [];
          const tracer = {
            startTrace() { calls.push("trace"); return { id: "t" }; },
            startSpan() { calls.push("span"); return { id: "s" }; },
            endSpan() { calls.push("endSpan"); },
            endTrace() { calls.push("endTrace"); },
          };
          ${directory === "mastra" || directory === "openai-agents" ? `const hook = integration[${JSON.stringify(factory)}](tracer);` : ""}
          ${exercise}
          if (calls.join(",") !== "trace,span,endSpan,endTrace") throw Error(calls);
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `], { cwd: scratch, stdio: "pipe" });
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
}
