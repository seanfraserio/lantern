import type { FastifyInstance } from "fastify";
import type { TenantStore } from "../store/tenant-store.js";
import type { SchemaManager } from "../store/schema-manager.js";
import { hashPassword, verifyPassword } from "../lib/passwords.js";
import { generateApiKey, hashApiKey } from "../lib/api-key-gen.js";
import { signJwt } from "../middleware/jwt.js";
import { recordMetric } from "../lib/observability.js";

const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  return null;
}

// Simple in-memory rate limiter for auth endpoints
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute
const RATE_LIMIT_MAX_REGISTER = 5;
const RATE_LIMIT_MAX_LOGIN = 10;

function checkRateLimit(key: string, max: number): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  entry.count++;
  return entry.count <= max;
}

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
      const clientIp = request.ip;
      if (!checkRateLimit(`register:${clientIp}`, RATE_LIMIT_MAX_REGISTER)) {
        return reply.status(429).send({ error: "Too many requests. Try again later." });
      }

      const { email, password, tenantSlug, tenantName } = request.body;
      if (!email || !password || !tenantSlug || !tenantName) {
        return reply.status(400).send({ error: "email, password, tenantSlug, and tenantName are required" });
      }

      const passwordError = validatePassword(password);
      if (passwordError) {
        return reply.status(400).send({ error: passwordError });
      }

      if (!schemaManager.validateSlug(tenantSlug)) {
        return reply.status(400).send({ error: "Slug must be 3-32 chars, lowercase alphanumeric and hyphens" });
      }

      const existingUser = await store.getUserByEmail(email);
      if (existingUser) {
        return reply.status(409).send({ error: "Registration failed — email or slug already in use" });
      }

      const existingTenant = await store.getTenantBySlug(tenantSlug);
      if (existingTenant) {
        return reply.status(409).send({ error: "Registration failed — email or slug already in use" });
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
      const clientIp = request.ip;
      if (!checkRateLimit(`login:${clientIp}`, RATE_LIMIT_MAX_LOGIN)) {
        return reply.status(429).send({ error: "Too many requests. Try again later." });
      }

      const { email, password } = request.body;
      if (!email || !password) {
        return reply.status(400).send({ error: "email and password are required" });
      }

      const user = await store.getUserByEmail(email);
      if (!user || !(await verifyPassword(password, user.passwordHash))) {
        recordMetric("auth_login_failed_total", 1, {});
        return reply.status(401).send({ error: "Invalid credentials" });
      }

      const tenant = await store.getTenantById(user.tenantId);
      if (!tenant) {
        return reply.status(500).send({ error: "Internal server error" });
      }

      recordMetric("auth_login_total", 1, {});
      const token = signJwt(
        { sub: user.id, tenantId: tenant.id, tenantSlug: tenant.slug, role: user.role },
        jwtSecret
      );
      return reply.send({ token, user: { id: user.id, email: user.email, role: user.role } });
    }
  );

  // POST /token/refresh — outside /auth/* so JWT middleware validates the current token
  app.post("/token/refresh", async (request, reply) => {
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
