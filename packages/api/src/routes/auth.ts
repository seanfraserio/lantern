import type { FastifyInstance } from "fastify";
import type { TenantStore } from "../store/tenant-store.js";
import type { SchemaManager } from "../store/schema-manager.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { generateApiKey, hashApiKey } from "../lib/api-key-gen.js";
import { signJwt } from "../middleware/jwt.js";

export function registerAuthRoutes(
  app: FastifyInstance,
  store: TenantStore,
  schemaManager: SchemaManager,
  jwtSecret: string
): void {
  // POST /auth/register — signup: create tenant + user + schema + first API key
  app.post<{ Body: { email: string; password: string; tenantSlug: string; tenantName: string } }>(
    "/auth/register",
    async (request, reply) => {
      const { email, password, tenantSlug, tenantName } = request.body;
      if (!email || !password || !tenantSlug || !tenantName) {
        return reply.status(400).send({ error: "email, password, tenantSlug, and tenantName are required" });
      }

      if (!schemaManager.validateSlug(tenantSlug)) {
        return reply.status(400).send({ error: "Slug must be 3-32 chars, lowercase alphanumeric and hyphens" });
      }

      const existingUser = await store.getUserByEmail(email);
      if (existingUser) {
        return reply.status(409).send({ error: "Email already registered" });
      }

      const existingTenant = await store.getTenantBySlug(tenantSlug);
      if (existingTenant) {
        return reply.status(409).send({ error: "Tenant slug already taken" });
      }

      const tenant = await store.createTenant(tenantName, tenantSlug);
      await schemaManager.createTenantSchema(tenantSlug);
      const passwordHash = await hashPassword(password);
      const user = await store.createUser(tenant.id, email, passwordHash, "owner");

      const { key, prefix } = generateApiKey();
      const keyHash = hashApiKey(key);
      await store.storeApiKey(tenant.id, keyHash, prefix, "Default");

      const token = signJwt(
        { sub: user.id, tenantId: tenant.id, tenantSlug: tenant.slug, role: user.role },
        jwtSecret
      );

      return reply.status(201).send({
        token,
        apiKey: key,
        user: { id: user.id, email: user.email, role: user.role },
        tenant: { id: tenant.id, slug: tenant.slug },
      });
    }
  );

  // POST /auth/login
  app.post<{ Body: { email: string; password: string } }>(
    "/auth/login",
    async (request, reply) => {
      const { email, password } = request.body;
      if (!email || !password) {
        return reply.status(400).send({ error: "email and password are required" });
      }

      const user = await store.getUserByEmail(email);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const tenant = await store.getTenantById(user.tenantId);
      if (!tenant) {
        return reply.status(500).send({ error: "Internal server error" });
      }

      const token = signJwt(
        { sub: user.id, tenantId: tenant.id, tenantSlug: tenant.slug, role: user.role },
        jwtSecret
      );
      return reply.send({ token, user: { id: user.id, email: user.email, role: user.role } });
    }
  );

  // POST /auth/refresh
  app.post("/auth/refresh", async (request, reply) => {
    const user = (request as unknown as Record<string, unknown>).user as
      | { sub: string; tenantId: string; tenantSlug: string; role: string }
      | null;
    if (!user) {
      return reply.status(401).send({ error: "Invalid token" });
    }
    const token = signJwt(
      { sub: user.sub, tenantId: user.tenantId, tenantSlug: user.tenantSlug, role: user.role },
      jwtSecret
    );
    return reply.send({ token });
  });
}
