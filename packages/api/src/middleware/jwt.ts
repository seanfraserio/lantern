import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";

const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export interface JwtPayload {
  sub: string;
  tenantId: string;
  tenantSlug: string;
  role: string;
  exp: number;
}

export function registerJwtAuth(app: FastifyInstance, signingKey: string, additionalSkipPaths?: string[]): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    // Explicit allowlist of unauthenticated paths — do NOT use prefix matching
    const publicPaths = ["/health", "/auth/register", "/auth/login", "/billing/webhook", "/retention/policy", "/retention/cleanup"];
    if (publicPaths.includes(request.url.split("?")[0]) || request.method === "OPTIONS") {
      return;
    }

    // Check additional skip paths (e.g. enterprise SSO routes)
    if (additionalSkipPaths) {
      for (const path of additionalSkipPaths) {
        if (path.endsWith("/") ? request.url.startsWith(path) : request.url === path) {
          return;
        }
      }
    }

    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing authorization header" });
    }

    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, signingKey, { algorithms: ["HS256"] }) as JwtPayload;
      if (!payload.tenantSlug || !SLUG_RE.test(payload.tenantSlug)) {
        return reply.status(401).send({ error: "Invalid token payload" });
      }
      (request as unknown as Record<string, unknown>).user = payload;
    } catch {
      return reply.status(401).send({ error: "Invalid or expired token" });
    }
  });
}

export function signJwt(payload: Omit<JwtPayload, "exp">, signingKey: string): string {
  return jwt.sign(payload, signingKey, { algorithm: "HS256", expiresIn: "24h" });
}

export function getUser(request: FastifyRequest): JwtPayload {
  const user = (request as unknown as Record<string, unknown>).user as JwtPayload | null;
  if (!user) throw new Error("No authenticated user");
  return user;
}
