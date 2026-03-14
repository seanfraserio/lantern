import type { FastifyInstance } from "fastify";

export function registerBillingRoutes(app: FastifyInstance): void {
  // TODO: Implement Stripe webhook handling
  app.post("/billing/webhook", async (_request, reply) => {
    return reply.status(200).send({ received: true });
  });
}
