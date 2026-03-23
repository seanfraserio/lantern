# Pricing and Plans

Understanding Lantern's pricing model: what each plan includes, how limits are
enforced, and what happens when they are exceeded.

---

## Plan Tiers

Lantern offers five tiers, each targeting a different stage of adoption:

### Community (free, self-hosted)

The Community plan is free and self-hosted. It includes the full open-source
core:

- Trace ingestion and storage (SQLite or PostgreSQL)
- TypeScript and Python SDKs with auto-instrumentation for 28 providers and frameworks
- Dashboard (traces, metrics, sources)
- Custom evaluation scorers
- Regression detection
- Unlimited agents
- Unlimited traces (self-hosted)
- Community support

**What is not included:**

- Managed cloud hosting
- PII detection and redaction
- Alert channels (Slack, PagerDuty, email, webhook)
- Team management and RBAC
- Cost forecasting and budgets
- SSO/SAML authentication
- Compliance exports (SOC 2, HIPAA, GDPR)
- LLM Proxy (zero-code tracing)
- Custom data retention

The Community plan is ideal for individual developers and small teams
evaluating agent observability. There is no account creation required for
self-hosted deployments -- the ingest server runs standalone with an optional
API key.

### Starter ($49/mo)

The Starter plan is a managed cloud offering for small teams getting started:

- Everything in Community
- Managed cloud ingest
- Up to 100,000 traces per month
- 30-day data retention
- Up to 5 users
- Basic email alerts
- Google + GitHub OAuth
- Dashboard (traces, metrics, sources)

The Starter plan is managed through Stripe. Users subscribe via
`POST /billing/checkout`, which creates a Stripe Checkout session.

### Team ($299/mo)

The Team plan is the most popular managed cloud offering, adding enterprise
features:

- Everything in Community
- Managed cloud ingest
- Up to 1,000,000 traces per month
- 90-day data retention
- Unlimited agents
- PII detection and auto-redaction
- Slack + webhook alerting
- Team-scoped RBAC
- Cost forecasting + budgets
- Google + GitHub OAuth
- Email support

The Team plan is managed through Stripe. Users subscribe via
`POST /billing/checkout`, which creates a Stripe Checkout session. The
subscription is a simple monthly fee with no per-trace overage charges.

### Team+ ($599/mo)

The Team+ plan is for high-volume agent workloads:

- Everything in Team
- Up to 5,000,000 traces per month (5x Team volume)
- 90-day data retention
- Unlimited agents
- Priority email support

### Enterprise (custom pricing)

The Enterprise plan adds compliance, SSO, and custom terms:

- Everything in Team+
- Effectively unlimited traces
- SOC 2 / HIPAA / GDPR audit export
- PagerDuty integration
- SSO / SAML (Okta, Azure AD)
- Magic Link email auth
- Custom trace retention
- LLM Proxy (zero-code tracing)
- Dedicated support + SLA

Enterprise plans are negotiated directly and not available through self-service
checkout.

---

## How Trace Limits Work

Trace limits are enforced per-tenant, per-month in multi-tenant mode. They
answer the question: "How many traces can this tenant ingest this calendar
month?"

### Where limits are checked

Limits are checked in the ingest server's request hook, before traces reach
the storage layer. Only POST requests to `/v1/traces` are subject to limits.
GET requests (queries) are never limited.

### The enforcement flow

1. An API key arrives with a `POST /v1/traces` request.
2. The ingest server resolves the API key to a tenant.
3. The server looks up the tenant's plan and current month's usage.
4. If usage is at or above the plan limit, the request is rejected with `429`.
5. If usage is below the limit, the request proceeds to storage.

### Plan limits

| Plan | Monthly trace limit |
|---|---|
| `free` (Community) | Unlimited (self-hosted), 10,000 (managed) |
| `starter` | 100,000 |
| `team` | 1,000,000 |
| `team_plus` | 5,000,000 |
| `enterprise` | 999,999,999 (effectively unlimited) |

---

## How Usage is Tracked

Usage tracking is designed for accuracy over time while tolerating short-term
imprecision.

### The usage table

The `public.usage` table stores monthly aggregates per tenant:

| Column | Description |
|---|---|
| `tenant_id` | The tenant UUID |
| `month` | Calendar month (e.g. `"2025-01"`) |
| `trace_count` | Number of traces ingested |
| `input_tokens` | Total input tokens across all traces |
| `output_tokens` | Total output tokens across all traces |

This table is updated as traces are ingested.

### The usage cache

To avoid querying the database on every ingestion request, the ingest server
maintains an in-memory cache of each tenant's usage:

```
{ tenantId -> { count, plan, checkedAt } }
```

The cache is refreshed every 60 seconds. This means:

- A tenant at 9,999 traces could ingest a burst past 10,000 before the cache
  refreshes.
- The over-ingestion window is at most 60 seconds and bounded by the batch
  size (100 traces per request).
- This is an intentional trade-off: strict per-request database checks would
  add latency to every ingestion call, degrading the SDK experience for all
  tenants.

### Monthly reset

Usage resets at the start of each calendar month. The `month` column in the
usage table serves as the partition key. No explicit "reset" operation is
needed -- the ingest server simply queries for the current month's row.

---

## What Happens When Limits are Exceeded

When a tenant exceeds their monthly trace limit:

1. The ingest server returns `429 Too Many Requests`:

```json
{
  "error": "Trace limit exceeded",
  "plan": "free",
  "used": 10000,
  "limit": 10000,
  "message": "Your free plan allows 10,000 traces/month. Upgrade at https://dashboard.openlanternai.com"
}
```

2. The SDK's `LanternExporter` receives the `429` response. Since `429` is
   not a `5xx` error, it is **not retried**. The traces are lost unless the
   calling code catches the error and buffers them.

3. Existing traces are not affected. The tenant can still query, view, and
   analyse their previously ingested traces.

4. The limit resets at the start of the next calendar month.

5. The tenant can upgrade their plan at any time via `POST /billing/checkout`
   to increase their limit immediately.

---

## Billing Flow

The billing system uses Stripe for payment processing:

### Subscribing

1. The user clicks "Upgrade" in the dashboard.
2. The dashboard calls `POST /billing/checkout`.
3. The API server creates a Stripe Checkout session with the Team plan price.
4. The user is redirected to Stripe's hosted checkout page.
5. After payment, Stripe sends a `checkout.session.completed` webhook.
6. The API server updates the tenant's plan to `team` and stores the
   subscription ID.

### Checking status

`GET /billing/status` returns the current plan, subscription details, and usage
against limits. The dashboard uses this to show:

- Current plan name
- Subscription status and renewal date
- Traces used vs. limit
- Percentage of limit consumed

### Managing subscriptions

`POST /billing/portal` creates a Stripe Customer Portal session where the user
can:

- Update payment method
- Cancel subscription
- View invoices

### Subscription lifecycle

The webhook handler processes three Stripe event types:

| Event | Action |
|---|---|
| `checkout.session.completed` | Set plan to the purchased tier (`starter`, `team`, `team_plus`), store subscription ID |
| `customer.subscription.deleted` | Revert plan to `free`, clear subscription ID |
| `customer.subscription.updated` | Update plan based on subscription status (`active` -> plan tier, `past_due`/`unpaid` -> `free`) |

If a subscription becomes `past_due` or `unpaid`, the tenant is downgraded to
the free plan. This means their trace limit drops to 10,000/month. However,
existing data is not deleted immediately -- it is cleaned up by the next
retention job run.

---

## Self-hosted vs. Managed

The pricing model differs significantly between self-hosted and managed
deployments:

### Self-hosted

When self-hosting with Docker Compose or a custom deployment, there are no
trace limits, no billing, and no plan restrictions. The open-source ingest
server in single-tenant mode does not enforce usage limits.

All features available in the open-source packages are usable without
restriction. Enterprise features (PII, compliance, alerts, teams) require the
`@openlantern-ai/enterprise` package, which is licensed separately.

### Managed (multi-tenant)

The managed cloud deployment enforces the plan-based limits described above.
Tenants are created via `POST /auth/register`, and each tenant starts on the
free plan.

The key difference is that multi-tenant mode is where the billing, usage
tracking, and limit enforcement systems are active. If you deploy the
multi-tenant stack yourself (by setting `MULTI_TENANT=true`), you get the
same enforcement behaviour -- but you would need to configure Stripe keys
to enable the upgrade flow.
