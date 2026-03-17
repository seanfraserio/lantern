import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import Database from "better-sqlite3";
import { PromptStore, extractVariables } from "../../store/prompt-store.js";
import { registerPromptRoutes } from "../../routes/prompts.js";

function createTestStore(): { store: PromptStore; db: Database.Database } {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  const store = new PromptStore(db);
  store.initialize();
  return { store, db };
}

describe("Prompt routes", () => {
  let app: FastifyInstance;
  let store: PromptStore;
  let db: Database.Database;

  beforeEach(async () => {
    ({ store, db } = createTestStore());
    app = Fastify({ logger: false });
    registerPromptRoutes(app, store);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    db.close();
  });

  // ── Create prompt ──

  it("creates a prompt", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greeting", description: "A greeting prompt" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.name).toBe("greeting");
    expect(body.description).toBe("A greeting prompt");
    expect(body.id).toBeDefined();
  });

  it("returns 409 on duplicate prompt name", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greeting" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greeting" },
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toMatch(/already exists/);
  });

  // ── Create version & variable extraction ──

  it("creates a version and extracts variables", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greet" },
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "Hello {{name}}, welcome to {{place}}!" },
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.version).toBe(1);
    expect(body.variables).toEqual(["name", "place"]);
  });

  it("auto-increments version numbers", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "test" },
    });
    const v1 = await app.inject({
      method: "POST",
      url: "/v1/prompts/test/versions",
      payload: { content: "v1 content" },
    });
    expect(JSON.parse(v1.body).version).toBe(1);

    const v2 = await app.inject({
      method: "POST",
      url: "/v1/prompts/test/versions",
      payload: { content: "v2 content" },
    });
    expect(JSON.parse(v2.body).version).toBe(2);

    const v3 = await app.inject({
      method: "POST",
      url: "/v1/prompts/test/versions",
      payload: { content: "v3 content" },
    });
    expect(JSON.parse(v3.body).version).toBe(3);
  });

  // ── Get active version ──

  it("gets active version", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greet" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "Hello {{name}}", activate: true },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prompts/greet",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.version).toBe(1);
    expect(body.isActive).toBe(true);
    expect(body.content).toBe("Hello {{name}}");
  });

  it("returns 404 when no active version", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greet" },
    });
    // Create version without activating
    await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "Hello" },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prompts/greet",
    });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toMatch(/no active version/i);
  });

  // ── Activate version ──

  it("activating a version deactivates previous", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greet" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "v1", activate: true },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "v2" },
    });

    // Activate v2
    const activateRes = await app.inject({
      method: "PUT",
      url: "/v1/prompts/greet/activate/2",
    });
    expect(activateRes.statusCode).toBe(200);

    // Active version should now be v2
    const activeRes = await app.inject({
      method: "GET",
      url: "/v1/prompts/greet",
    });
    const active = JSON.parse(activeRes.body);
    expect(active.version).toBe(2);
    expect(active.content).toBe("v2");

    // Verify v1 is no longer active via versions list
    const versionsRes = await app.inject({
      method: "GET",
      url: "/v1/prompts/greet/versions",
    });
    const versions = JSON.parse(versionsRes.body).versions;
    const v1 = versions.find((v: { version: number }) => v.version === 1);
    const v2 = versions.find((v: { version: number }) => v.version === 2);
    expect(v1.isActive).toBe(false);
    expect(v2.isActive).toBe(true);
  });

  // ── List prompts ──

  it("lists prompts with active version info", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greet", description: "Greeting" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "Hello {{name}} from {{city}}", activate: true },
    });

    const res = await app.inject({
      method: "GET",
      url: "/v1/prompts",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.prompts).toHaveLength(1);
    expect(body.prompts[0].name).toBe("greet");
    expect(body.prompts[0].activeVersion).toBe(1);
    expect(body.prompts[0].variableCount).toBe(2);
  });

  // ── Delete prompt ──

  it("deletes a prompt and cascades to versions", async () => {
    await app.inject({
      method: "POST",
      url: "/v1/prompts",
      payload: { name: "greet" },
    });
    await app.inject({
      method: "POST",
      url: "/v1/prompts/greet/versions",
      payload: { content: "Hello", activate: true },
    });

    const deleteRes = await app.inject({
      method: "DELETE",
      url: "/v1/prompts/greet",
    });
    expect(deleteRes.statusCode).toBe(204);

    // Prompt should no longer appear in list
    const listRes = await app.inject({
      method: "GET",
      url: "/v1/prompts",
    });
    expect(JSON.parse(listRes.body).prompts).toHaveLength(0);

    // Active version should not be found
    const activeRes = await app.inject({
      method: "GET",
      url: "/v1/prompts/greet",
    });
    expect(activeRes.statusCode).toBe(404);
  });
});

// ── extractVariables unit tests ──

describe("extractVariables", () => {
  it("extracts simple variables", () => {
    expect(extractVariables("Hello {{name}}")).toEqual(["name"]);
  });

  it("extracts multiple variables", () => {
    expect(extractVariables("{{greeting}} {{name}}, welcome to {{place}}")).toEqual([
      "greeting",
      "name",
      "place",
    ]);
  });

  it("deduplicates variables", () => {
    expect(extractVariables("{{name}} and {{name}} again")).toEqual(["name"]);
  });

  it("returns empty array when no variables", () => {
    expect(extractVariables("No variables here")).toEqual([]);
  });

  it("handles underscored variable names", () => {
    expect(extractVariables("{{first_name}} {{last_name}}")).toEqual([
      "first_name",
      "last_name",
    ]);
  });

  it("ignores non-word characters inside braces", () => {
    // Only \w+ matches, so {{foo-bar}} won't match
    expect(extractVariables("{{foo-bar}}")).toEqual([]);
  });
});
