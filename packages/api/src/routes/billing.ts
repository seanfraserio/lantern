import type { FastifyInstance } from "fastify";
import Stripe from "stripe";
import type pg from "pg";
import { getUser } from "../middleware/jwt.js";

export interface BillingConfig {
  stripeSecretKey: string;
  stripePriceId: string;
  appUrl: string;
  stripeWebhookSecret: string;
}

export function registerBillingRoutes(
  app: FastifyInstance,
  pool: pg.Pool,
  config: BillingConfig
): void {
  const stripe = new Stripe(config.stripeSecretKey);

  // POST /billing/checkout — create a Stripe Checkout session
  app.post("/billing/checkout", async (request, reply) => {
    const user = getUser(request);

    const { rows } = await pool.query(
      "SELECT * FROM public.tenants WHERE id = $1",
      [user.tenantId]
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: "Tenant not found" });
    }

    const tenant = rows[0];

    // Get user email for Stripe customer
    const { rows: userRows } = await pool.query(
      "SELECT email FROM public.users WHERE id = $1",
      [user.sub]
    );
    const email = userRows[0]?.email as string;

    // Create or reuse Stripe customer
    let customerId = tenant.stripe_customer_id as string | null;
    if (!customerId) {
      const customer = await stripe.customers.create({
        email,
        name: tenant.name as string,
        metadata: { tenantId: user.tenantId, tenantSlug: user.tenantSlug },
      });
      customerId = customer.id;
      await pool.query(
        "UPDATE public.tenants SET stripe_customer_id = $1, updated_at = now() WHERE id = $2",
        [customerId, user.tenantId]
      );
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: config.stripePriceId, quantity: 1 }],
      success_url: `${config.appUrl}?billing=success`,
      cancel_url: `${config.appUrl}?billing=cancelled`,
      metadata: { tenantId: user.tenantId },
    });

    return reply.send({ url: session.url });
  });

  // GET /billing/status — get current billing status
  app.get("/billing/status", async (request, reply) => {
    const user = getUser(request);

    const { rows } = await pool.query(
      "SELECT plan, stripe_customer_id, stripe_subscription_id FROM public.tenants WHERE id = $1",
      [user.tenantId]
    );
    if (rows.length === 0) {
      return reply.status(404).send({ error: "Tenant not found" });
    }

    const tenant = rows[0];
    let subscription = null;

    if (tenant.stripe_subscription_id) {
      try {
        const sub = await stripe.subscriptions.retrieve(tenant.stripe_subscription_id as string);
        subscription = {
          status: sub.status,
          currentPeriodEnd: new Date((sub as unknown as Record<string, number>).current_period_end * 1000).toISOString(),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        };
      } catch {
        // Subscription may have been deleted
      }
    }

    const month = new Date().toISOString().slice(0, 7);
    const { rows: usageRows } = await pool.query(
      "SELECT trace_count, input_tokens, output_tokens FROM public.usage WHERE tenant_id = $1 AND month = $2",
      [user.tenantId, month]
    );

    const usage = usageRows.length > 0
      ? { traceCount: Number(usageRows[0].trace_count), inputTokens: Number(usageRows[0].input_tokens), outputTokens: Number(usageRows[0].output_tokens) }
      : { traceCount: 0, inputTokens: 0, outputTokens: 0 };

    const planLimits: Record<string, number> = { free: 10_000, team: 1_000_000, enterprise: 999_999_999 };
    const plan = (tenant.plan as string) ?? "free";
    const limit = planLimits[plan] ?? planLimits.free;
    const pctUsed = limit > 0 ? Math.round((usage.traceCount / limit) * 100) : 0;

    return reply.send({
      plan,
      subscription,
      usage,
      limits: {
        tracesPerMonth: limit,
        used: usage.traceCount,
        remaining: Math.max(0, limit - usage.traceCount),
        percentUsed: pctUsed,
      },
    });
  });

  // POST /billing/portal — Stripe customer portal
  app.post("/billing/portal", async (request, reply) => {
    const user = getUser(request);

    const { rows } = await pool.query(
      "SELECT stripe_customer_id FROM public.tenants WHERE id = $1",
      [user.tenantId]
    );

    const customerId = rows[0]?.stripe_customer_id as string | null;
    if (!customerId) {
      return reply.status(400).send({ error: "No billing account. Subscribe first." });
    }

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: config.appUrl,
    });

    return reply.send({ url: session.url });
  });

  // POST /billing/webhook — Stripe webhook events
  app.post("/billing/webhook", async (request, reply) => {
    const sig = request.headers["stripe-signature"];
    if (!sig) {
      return reply.status(400).send({ error: "Missing stripe-signature header" });
    }

    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        (request as unknown as { rawBody: Buffer }).rawBody,
        sig,
        config.stripeWebhookSecret
      );
    } catch (err) {
      request.log.warn({ err }, "Stripe webhook signature verification failed");
      return reply.status(400).send({ error: "Invalid webhook signature" });
    }

    try {
      switch (event.type) {
        case "checkout.session.completed": {
          const session = event.data.object as Stripe.Checkout.Session;
          const tenantId = session.metadata?.tenantId;
          if (tenantId && session.subscription) {
            await pool.query(
              "UPDATE public.tenants SET stripe_subscription_id = $1, plan = 'team', updated_at = now() WHERE id = $2",
              [session.subscription as string, tenantId]
            );
          }
          break;
        }
        case "customer.subscription.deleted": {
          const sub = event.data.object as Stripe.Subscription;
          await pool.query(
            "UPDATE public.tenants SET plan = 'free', stripe_subscription_id = NULL, updated_at = now() WHERE stripe_subscription_id = $1",
            [sub.id]
          );
          break;
        }
        case "customer.subscription.updated": {
          const sub = event.data.object as Stripe.Subscription;
          if (sub.status === "active") {
            await pool.query("UPDATE public.tenants SET plan = 'team', updated_at = now() WHERE stripe_subscription_id = $1", [sub.id]);
          } else if (sub.status === "past_due" || sub.status === "unpaid") {
            await pool.query("UPDATE public.tenants SET plan = 'free', updated_at = now() WHERE stripe_subscription_id = $1", [sub.id]);
          }
          break;
        }
      }
      return reply.send({ received: true });
    } catch (error) {
      request.log.error(error);
      return reply.status(500).send({ error: "Webhook processing failed" });
    }
  });
}
