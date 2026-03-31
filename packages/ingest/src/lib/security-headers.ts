import type { FastifyInstance } from "fastify";

export interface SecurityHeadersOptions {
  /** Include Cache-Control: no-store (default: true) */
  cacheControl?: boolean;
  /** Include HSTS header (default: true) */
  hsts?: boolean;
  /** Include Content-Security-Policy header (provide the directive string) */
  csp?: string;
  /** Include Permissions-Policy header (provide the policy string) */
  permissionsPolicy?: string;
  /** Copy X-Request-Id from request.id to response (default: false) */
  requestId?: boolean;
}

/**
 * Register security headers as an onSend hook on a Fastify instance.
 *
 * Base headers (always set):
 *   X-Content-Type-Options: nosniff
 *   X-Frame-Options: DENY
 *   Referrer-Policy: strict-origin-when-cross-origin
 *
 * Optional headers (opt-in via options):
 *   Cache-Control: no-store                              (cacheControl, default true)
 *   Strict-Transport-Security: max-age=63072000; ...     (hsts, default true)
 *   Content-Security-Policy: <value>                     (csp)
 *   Permissions-Policy: <value>                          (permissionsPolicy)
 *   X-Request-Id: <request.id>                           (requestId)
 */
export async function registerSecurityHeaders(
  app: FastifyInstance,
  options: SecurityHeadersOptions = {},
): Promise<void> {
  const {
    cacheControl = true,
    hsts = true,
    csp,
    permissionsPolicy,
    requestId = false,
  } = options;

  app.addHook("onSend", async (request, reply) => {
    // Base headers — always present
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Referrer-Policy", "strict-origin-when-cross-origin");

    // Optional headers
    if (cacheControl) {
      reply.header("Cache-Control", "no-store");
    }
    if (hsts) {
      reply.header(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains",
      );
    }
    if (csp) {
      reply.header("Content-Security-Policy", csp);
    }
    if (permissionsPolicy) {
      reply.header("Permissions-Policy", permissionsPolicy);
    }
    if (requestId) {
      reply.header("X-Request-Id", request.id);
    }
  });
}
