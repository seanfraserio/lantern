import type { FastifyInstance } from "fastify";
import type { PromptStore } from "../store/prompt-store.js";

const VALID_PROMPT_NAME = /^[a-zA-Z0-9_-]{1,128}$/;
const MAX_CONTENT_LENGTH = 100_000;

export function registerPromptRoutes(app: FastifyInstance, store: PromptStore): void {
  // POST /v1/prompts — create a new prompt
  app.post<{
    Body: { name: string; description?: string };
  }>("/v1/prompts", async (request, reply) => {
    const { name, description } = request.body ?? {};

    if (!name || typeof name !== "string" || name.trim().length === 0) {
      return reply.status(400).send({ error: "name is required" });
    }
    if (!VALID_PROMPT_NAME.test(name.trim())) {
      return reply.status(400).send({
        error: "Invalid prompt name. Must match /^[a-zA-Z0-9_-]{1,128}$/.",
      });
    }

    try {
      const prompt = await store.createPrompt(name.trim(), description);
      return reply.status(201).send(prompt);
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { code?: string }).code === "DUPLICATE") {
        return reply.status(409).send({ error: err.message });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /v1/prompts — list all prompts
  app.get("/v1/prompts", async (request, reply) => {
    try {
      const prompts = await store.listPrompts();
      return reply.status(200).send({ prompts });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /v1/prompts/:name — get active version of a prompt
  app.get<{ Params: { name: string } }>("/v1/prompts/:name", async (request, reply) => {
    if (!VALID_PROMPT_NAME.test(request.params.name)) {
      return reply.status(400).send({ error: "Invalid prompt name." });
    }
    try {
      const version = await store.getActiveVersion(request.params.name);
      if (!version) {
        return reply.status(404).send({ error: "No active version found" });
      }
      return reply.status(200).send(version);
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // GET /v1/prompts/:name/versions — list all versions of a prompt
  app.get<{ Params: { name: string } }>("/v1/prompts/:name/versions", async (request, reply) => {
    if (!VALID_PROMPT_NAME.test(request.params.name)) {
      return reply.status(400).send({ error: "Invalid prompt name." });
    }
    try {
      const versions = await store.listVersions(request.params.name);
      return reply.status(200).send({ versions });
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // POST /v1/prompts/:name/versions — create a new version
  app.post<{
    Params: { name: string };
    Body: { content: string; model?: string; activate?: boolean };
  }>("/v1/prompts/:name/versions", async (request, reply) => {
    if (!VALID_PROMPT_NAME.test(request.params.name)) {
      return reply.status(400).send({ error: "Invalid prompt name." });
    }
    const { content, model, activate } = request.body ?? {};

    if (!content || typeof content !== "string") {
      return reply.status(400).send({ error: "content is required" });
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return reply.status(400).send({
        error: `Content exceeds maximum length of ${MAX_CONTENT_LENGTH} characters.`,
      });
    }

    try {
      const version = await store.createVersion(
        request.params.name,
        content,
        model,
        activate
      );
      return reply.status(201).send(version);
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { code?: string }).code === "NOT_FOUND") {
        return reply.status(404).send({ error: err.message });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // PUT /v1/prompts/:name/activate/:version — activate a specific version
  app.put<{
    Params: { name: string; version: string };
  }>("/v1/prompts/:name/activate/:version", async (request, reply) => {
    if (!VALID_PROMPT_NAME.test(request.params.name)) {
      return reply.status(400).send({ error: "Invalid prompt name." });
    }
    const versionNum = parseInt(request.params.version, 10);
    if (isNaN(versionNum) || versionNum < 1) {
      return reply.status(400).send({ error: "version must be a positive integer" });
    }

    try {
      await store.activateVersion(request.params.name, versionNum);
      return reply.status(200).send({ activated: versionNum });
    } catch (err: unknown) {
      if (err instanceof Error && (err as Error & { code?: string }).code === "NOT_FOUND") {
        return reply.status(404).send({ error: err.message });
      }
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });

  // DELETE /v1/prompts/:name — delete a prompt and all its versions
  app.delete<{ Params: { name: string } }>("/v1/prompts/:name", async (request, reply) => {
    if (!VALID_PROMPT_NAME.test(request.params.name)) {
      return reply.status(400).send({ error: "Invalid prompt name." });
    }
    try {
      await store.deletePrompt(request.params.name);
      return reply.status(204).send();
    } catch (err) {
      request.log.error(err);
      return reply.status(500).send({ error: "Internal server error" });
    }
  });
}
