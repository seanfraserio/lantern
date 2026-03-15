# Security Model

How Lantern protects data, authenticates users, and isolates tenants. This
document explains the security design decisions and their trade-offs.

---

## Authentication: Two Mechanisms for Two Audiences

Lantern uses two separate authentication mechanisms, each designed for a
different access pattern:

### JWT for dashboard users

Dashboard users (humans) authenticate with email and password via
`POST /auth/login`. The server returns a JWT token that the dashboard stores
and sends with every subsequent request.

The JWT is HS256-signed, expires after 24 hours, and contains the user's ID,
tenant ID, tenant slug, and role. The API server validates the signature and
expiry on every request.

This design serves the dashboard well: JWT tokens are stateless, so the API
server does not need to maintain sessions. Token refresh is available at
`POST /token/refresh` to extend sessions without re-entering credentials.

### API keys for trace ingestion

SDKs and the LLM proxy authenticate using API keys (prefixed with `ltn_`).
These are long-lived credentials designed for programmatic use. They are sent
as Bearer tokens in the `Authorization` header.

API keys are distinct from JWT tokens because they serve a fundamentally
different purpose. SDKs run in automated environments (CI pipelines, server
processes, edge functions) where interactive login is impractical. API keys
can be rotated independently, scoped per purpose (e.g. one for CI, one for
production), and revoked without affecting the user's dashboard session.

---

## Why API Keys Use SHA-256 Hashing

API keys are never stored in plaintext. When a key is created, it is hashed
with SHA-256 before being persisted. Only the hash and a short display prefix
(e.g. `ltn_abc1`) are stored in the database.

The choice of SHA-256 (rather than bcrypt or argon2) is deliberate:

**Speed matters for request authentication.** Every trace ingestion request
requires a key lookup. With high-volume agents sending thousands of traces per
minute, the authentication step must be fast. SHA-256 is a single-pass hash
that completes in microseconds. Bcrypt, designed to be intentionally slow,
would add significant latency to every API call.

**Brute-force resistance through key length.** SHA-256's lack of work factor
is not a concern because API keys are generated with sufficient entropy
(cryptographically random, not user-chosen passwords). A 256-bit random key
has more entropy than any password, making brute-force attacks infeasible
regardless of hash speed.

**Passwords use bcrypt.** User passwords, which are chosen by humans and
therefore lower-entropy, are hashed with bcrypt (with salt). The rate-limited
login endpoint adds a further layer of protection against credential stuffing.

---

## Tenant Isolation

Lantern isolates tenant data using PostgreSQL schema-per-tenant separation.
Each tenant's traces live in a dedicated schema (`tenant_<slug>`), with its
own tables and indexes.

### What isolation provides

- **Query-level separation.** A query against one tenant's schema cannot access
  another tenant's data, even if there is a bug in a query filter. The
  PostgreSQL schema boundary is enforced by the database engine.

- **Index independence.** Each tenant's `traces` table has its own indexes.
  One tenant's high write volume does not bloat another tenant's indexes or
  slow their queries.

- **Independent retention.** Traces can be deleted per-schema, making it
  straightforward to apply different retention policies to different tenants
  based on their plan.

### What isolation does not provide

Schema-per-tenant is not database-per-tenant. All tenants share the same
PostgreSQL cluster, connection pool, and server resources. A tenant with
extremely high query volume could still affect others through resource
contention (CPU, I/O, connection pool exhaustion).

For tenants requiring complete resource isolation, a separate PostgreSQL
cluster should be provisioned.

### Shared state

Certain data is shared across tenants in the `public` schema:

- User accounts and authentication
- API key hashes
- Billing and subscription state
- Usage tracking
- SLA targets and regression events

Access to shared tables is always scoped by `tenant_id` in the query. The
shared tables do not contain trace content -- they hold metadata only.

---

## Rate Limiting

Lantern implements rate limiting at two levels:

### Authentication rate limiting

The API server applies per-IP rate limits to authentication endpoints:

| Endpoint | Limit |
|---|---|
| `POST /auth/register` | 5 requests per minute per IP |
| `POST /auth/login` | 10 requests per minute per IP |

These limits use an in-memory rate limiter that resets every 60 seconds. This
prevents credential stuffing and registration abuse.

**Limitation:** The in-memory rate limiter does not persist across server
restarts or scale across multiple instances. In a multi-instance deployment,
each instance maintains its own rate limit state, effectively multiplying the
allowed rate by the number of instances.

### Trace ingestion limits

In multi-tenant mode, the ingest server enforces monthly trace limits based on
the tenant's plan:

| Plan | Traces per month |
|---|---|
| `free` | 10,000 |
| `team` | 1,000,000 |
| `enterprise` | Effectively unlimited |

Usage is checked from the `public.usage` table and cached for 60 seconds per
tenant. When the limit is exceeded, POST requests to `/v1/traces` receive a
`429 Too Many Requests` response. GET requests (queries) are not subject to
this limit.

**Limitation:** The 60-second cache means a burst of requests immediately after
the limit is reached may still be accepted. This is an intentional trade-off
favouring ingestion throughput over strict enforcement.

---

## CORS Configuration

The API server allows cross-origin requests from a specific set of origins:

- `https://app.openlanternai.com`
- `https://dashboard.openlanternai.com`
- `https://openlanternai-dashboard.pages.dev`
- `http://localhost:*` (any port, for local development)

All other origins are rejected (the `Access-Control-Allow-Origin` header is
not set). This prevents malicious websites from making authenticated requests
to the API on behalf of a logged-in user.

`OPTIONS` preflight requests are handled automatically and bypass JWT
authentication.

---

## Security Headers

Both the ingest server and API server set the following headers on every
response:

| Header | Value | Purpose |
|---|---|---|
| `X-Content-Type-Options` | `nosniff` | Prevents MIME type sniffing |
| `X-Frame-Options` | `DENY` | Prevents clickjacking via iframes |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | Enforces HTTPS for 2 years |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limits referrer information leakage |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disables unnecessary browser features |

The API server additionally sets:

| Header | Value |
|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` |

The HSTS header with `max-age=63072000` (2 years) tells browsers to always use
HTTPS for the domain, even if the user types `http://`. The `includeSubDomains`
directive extends this to all subdomains.

---

## PII Detection and Redaction

The enterprise package includes a `PiiDetector` class that scans text for
personally identifiable information. The API server exposes this through three
endpoints:

- `POST /pii/scan` -- scan arbitrary text for PII
- `POST /pii/redact` -- redact PII from text
- `POST /pii/scan-trace/:id` -- scan all spans within a trace

PII detection is pattern-based and runs entirely server-side. No trace data
is sent to external services for PII detection.

When scanning a trace, the detector examines:
- Input messages across all spans
- Output content across all spans

Detected PII types include email addresses, phone numbers, person names, and
other identifiable patterns. Redaction replaces detected entities with
type-specific placeholders (e.g. `[EMAIL_REDACTED]`).

---

## Stripe Webhook Signature Verification

The billing webhook endpoint (`POST /billing/webhook`) verifies the integrity
and authenticity of incoming Stripe events:

1. The `stripe-signature` header contains a timestamp and HMAC signature.
2. The raw request body (preserved by the API server's custom body parser) is
   used to compute the expected signature.
3. Stripe's `webhooks.constructEvent()` verifies the signature using the
   `STRIPE_WEBHOOK_SECRET`.
4. If verification fails, the request is rejected with `400`.

This prevents attackers from forging webhook events to manipulate tenant plans
or subscription state.

The webhook endpoint bypasses JWT authentication (it is in the JWT skip list)
because Stripe cannot provide JWT tokens.

---

## SSO/SAML Authentication

Enterprise deployments can configure SSO/SAML authentication. The API server
supports additional JWT skip paths via the `additionalJwtSkipPaths` configuration
option, allowing SSO login and callback routes to operate outside the normal
JWT flow.

SSO routes are typically registered by the enterprise package and follow the
standard SAML flow:

1. User visits the SSO login URL for their tenant.
2. The user is redirected to the identity provider.
3. After authentication, the IdP sends a SAML assertion to the callback URL.
4. The callback route validates the assertion and issues a JWT token.
5. The user is redirected to the dashboard with the token.

---

## Data Retention Policies

Traces are retained according to plan-based policies:

| Plan | Retention |
|---|---|
| `free` | 7 days |
| `team` | 90 days |
| `enterprise` | 365 days |

The `POST /retention/cleanup` endpoint runs the cleanup job. It is designed to
be called by a scheduler (Cloud Scheduler, cron) rather than interactively. It
is protected by a shared secret (`RETENTION_SECRET`) rather than JWT, because
the caller is a machine, not a user.

The cleanup job iterates over all tenants, determines their retention period
based on plan, and deletes traces with `start_time` older than the cutoff.
Each tenant's cleanup is independent -- a failure for one tenant does not
prevent cleanup for others.

The retention policy is viewable publicly at `GET /retention/policy` so that
users can understand the data lifecycle without authentication.

---

## Password Requirements

User passwords must meet the following requirements:

- Minimum 8 characters
- At least one lowercase letter
- At least one uppercase letter
- At least one digit

Passwords are hashed with bcrypt before storage. The raw password is never
logged, stored, or transmitted after the initial registration or login request.
