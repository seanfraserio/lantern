import type { FastifyInstance } from "fastify";
import type { TenantStore } from "../store/tenant-store.js";
import { generateApiKey, hashApiKey } from "../lib/api-key-gen.js";
import { getUser } from "../middleware/jwt.js";

export function registerApiKeyRoutes(app: FastifyInstance, store: TenantStore): void {
  app.post<{ Body: { name: string } }>("/api-keys", async (request, reply) => {
    const user = getUser(request);
    const { name } = request.body;
    if (!name) return reply.status(400).send({ error: "name is required" });

    const { key, prefix } = generateApiKey();
    const keyHash = hashApiKey(key);
    const record = await store.storeApiKey(user.tenantId, keyHash, prefix, name);

    return reply.status(201).send({
      id: record.id,
      key,
      prefix: record.keyPrefix,
      name: record.name,
      createdAt: record.createdAt,
    });
  });

  app.get("/api-keys", async (request) => {
    const user = getUser(request);
    return { keys: await store.listApiKeys(user.tenantId) };
  });

  app.delete<{ Params: { id: string } }>("/api-keys/:id", async (request, reply) => {
    const user = getUser(request);
    const revoked = await store.revokeApiKey(request.params.id, user.tenantId);
    if (!revoked) return reply.status(404).send({ error: "Key not found or already revoked" });
    return reply.send({ revoked: true });
  });
}
