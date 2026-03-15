import type { FastifyInstance } from "fastify";
import type { TenantStore } from "../store/tenant-store.js";
import { generateApiKey, hashApiKey } from "../lib/api-key-gen.js";
import { getUser } from "../middleware/jwt.js";

const keyCreateMap = new Map<string, { count: number; resetAt: number }>();

function checkKeyRateLimit(tenantId: string): boolean {
  const now = Date.now();
  const entry = keyCreateMap.get(tenantId);
  if (!entry || now > entry.resetAt) {
    keyCreateMap.set(tenantId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  entry.count++;
  return entry.count <= 10; // 10 keys per minute per tenant
}

export function registerApiKeyRoutes(app: FastifyInstance, store: TenantStore): void {
  app.post<{ Body: { name: string } }>("/api-keys", async (request, reply) => {
    const user = getUser(request);
    if (!checkKeyRateLimit(user.tenantId)) {
      return reply.status(429).send({ error: "Too many requests" });
    }
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
