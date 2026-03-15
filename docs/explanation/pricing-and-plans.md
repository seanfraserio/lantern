# Pricing and Plans

Understanding Lantern's pricing model: what each plan includes, how limits are
enforced, and what happens when they are exceeded.

---

## Plan Tiers

Lantern offers three tiers, each targeting a different stage of adoption:

### Community (free, self-hosted)

The Community plan is free and self-hosted. It includes the full open-source
core:

- Trace ingestion and storage (SQLite or PostgreSQL)
- TypeScript and Python SDKs
- LLM Proxy
- Scorecards and quality metrics
- Regression detection
- Cost analysis and forecasting
- Budget alerts
- Up to 10,000 traces per month (in managed multi-tenant mode)
- 7-day data retention

**What is not included:**

- PII detection and redaction
- Compliance exports (SOC 2, HIPAA, GDPR)
- Alert channels (Slack, PagerDuty, email, webhook)
- Team management and RBAC
- SSO/SAML authentication
- Managed cloud hosting
- Custom data retention

The Community plan is ideal for individual developers and small teams
evaluating agent observability. There is no account creation required for
self-hosted deployments -- the ingest server runs standalone with an optional
API key.

### Team ($299/mo)

The Team plan is a managed cloud offering that adds enterprise features on top
of the open-source core:

- Everything in Community
- Managed cloud deployment (no infrastructure to maintain)
- 1,000,000 traces per month
- 90-day data retention
- PII detection and redaction
- Alert channels (Slack, PagerDuty, email, webhook)
- Team management with role-based access control
- Agent scope restrictions per team

The Team plan is managed through Stripe. Users subscribe via
`POST /billing/checkout`, which creates a Stripe Checkout session. The
subscription is a simple monthly fee with no per-trace overage charges.

### Enterprise (custom pricing)

The Enterprise plan adds compliance, SSO, and custom terms:

- Everything in Team
- Effectively unlimited traces
- 365-day data retention (or custom)
- Compliance exports (SOC 2 Type II, HIPAA, GDPR)
- SSO/SAML authentication
- Custom retention policies
- Dedicated support
- Custom pricing

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
| `free` | 10,000 |
| `team` | 1,000,000 |
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
  "message": "Your free plan allows 10,000 traces/month. Upgrade at https://openlanternai-dashboard.pages.dev"
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
| `checkout.session.completed` | Set plan to `team`, store subscription ID |
| `customer.subscription.deleted` | Revert plan to `free`, clear subscription ID |
| `customer.subscription.updated` | Update plan based on subscription status (`active` -> `team`, `past_due`/`unpaid` -> `free`) |

If a subscription becomes `past_due` or `unpaid`, the tenant is downgraded to
the free plan. This means their trace limit drops to 10,000/month and their
data retention shortens to 7 days. However, existing data is not deleted
immediately -- it is cleaned up by the next retention job run.

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
`@lantern-ai/enterprise` package, which is licensed separately.

### Managed (multi-tenant)

The managed cloud deployment enforces the plan-based limits described above.
Tenants are created via `POST /auth/register`, and each tenant starts on the
free plan.

The key difference is that multi-tenant mode is where the billing, usage
tracking, and limit enforcement systems are active. If you deploy the
multi-tenant stack yourself (by setting `MULTI_TENANT=true`), you get the
same enforcement behaviour -- but you would need to configure Stripe keys
to enable the upgrade flow.
