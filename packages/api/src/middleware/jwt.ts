import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import jwt from "jsonwebtoken";

export interface JwtPayload {
  sub: string;
  tenantId: string;
  tenantSlug: string;
  role: string;
  exp: number;
}

export function registerJwtAuth(app: FastifyInstance, signingKey: string): void {
  app.decorateRequest("user", null);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url === "/health" || request.url.startsWith("/auth/") || request.method === "OPTIONS") {
      return;
    }

    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return reply.status(401).send({ error: "Missing authorization header" });
    }

    const token = auth.slice(7);
    try {
      const payload = jwt.verify(token, signingKey, { algorithms: ["HS256"] }) as JwtPayload;
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
