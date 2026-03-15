# Enterprise Dashboard Phase 2 — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a React SPA dashboard in the `lantern-enterprise` repo that exposes scorecards, regressions, traces, sources, team management, API keys, and settings — backed by the existing API server with targeted backend additions.

**Architecture:** Feature-based React SPA with Vite, React Router v6, CSS Modules. JWT auth against the existing API server. Deployed as a static site to Cloudflare Pages. Backend additions (team member endpoints, password reset, SLA listing) are made in the enterprise repo's `api/` directory.

**Tech Stack:** React 18, React Router 6, Vite 5, TypeScript, CSS Modules, Vitest + React Testing Library

**Spec:** `docs/superpowers/specs/2026-03-15-enterprise-dashboard-phase2-design.md`

**Repo:** All work happens in the `lantern-enterprise` repo at `/Users/sfraser/DevOps/Projects/lantern/packages/enterprise/`

---

## Chunk 1: Backend Additions

These backend changes go in `api/src/routes/` within the enterprise repo. They must be completed before the dashboard can consume them.

### Task 1: Schema migrations — display_name and password_reset_tokens

**Files:**
- Modify: `api/src/store/tenant-store.ts` (add `display_name` column to users table creation)

- [ ] **Step 1: Add display_name column to users table DDL**

In `api/src/store/tenant-store.ts`, update the `CREATE TABLE IF NOT EXISTS public.users` statement to include `display_name TEXT`:

```sql
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(id),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'member',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Add password_reset_tokens table creation to TenantStore.initialize()**

Append to the `initialize()` method in `tenant-store.ts`:

```sql
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prt_token_hash ON public.password_reset_tokens(token_hash);
```

- [ ] **Step 3: Build and verify**

Run: `cd api && pnpm build`
Expected: Clean build with no errors

- [ ] **Step 4: Commit**

```bash
git add api/src/store/tenant-store.ts
git commit -m "feat: add display_name column and password_reset_tokens table"
```

---

### Task 2: Password reset endpoints

**Files:**
- Modify: `api/src/routes/auth.ts`
- Modify: `api/src/store/tenant-store.ts` (make `pool` public)

**Note:** The JWT middleware already skips all routes starting with `/auth/`, so `/auth/forgot-password` and `/auth/reset-password` are automatically excluded from JWT auth. No changes to `jwt.ts` are needed.

- [ ] **Step 1: Make TenantStore pool public**

In `api/src/store/tenant-store.ts`, the password reset routes need direct pool access. Change:

```typescript
constructor(private pool: pg.Pool) {}
```

to:

```typescript
constructor(public readonly pool: pg.Pool) {}
```

- [ ] **Step 2: Ensure validatePassword and checkRateLimit exist in auth.ts**

Check if `api/src/routes/auth.ts` already has `validatePassword()` and `checkRateLimit()` functions (they were added in the security hardening pass). If not, add them at the top of the file before `registerAuthRoutes()`:

```typescript
const MIN_PASSWORD_LENGTH = 8;

function validatePassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  if (!/[a-z]/.test(password)) return "Password must contain a lowercase letter";
  if (!/[A-Z]/.test(password)) return "Password must contain an uppercase letter";
  if (!/[0-9]/.test(password)) return "Password must contain a number";
  return null;
}

const rateLimitMap = new Map<string, { count: number; resetAt: number }>();
const RATE_LIMIT_WINDOW_MS = 60_000;

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
```

- [ ] **Step 3: Add forgot-password endpoint**

In `api/src/routes/auth.ts`, add inside `registerAuthRoutes()` after the login route:

```typescript
// POST /auth/forgot-password — request password reset
app.post<{ Body: { email: string } }>(
  "/auth/forgot-password",
  async (request, reply) => {
    const clientIp = request.ip;
    if (!checkRateLimit(`forgot:${clientIp}`, 3)) {
      return reply.status(429).send({ error: "Too many requests. Try again later." });
    }

    const { email } = request.body;
    if (!email) return reply.status(400).send({ error: "email is required" });

    // Always return 200 to prevent email enumeration
    const user = await store.getUserByEmail(email);
    if (user) {
      const { randomBytes, createHash } = await import("node:crypto");
      const rawToken = randomBytes(32).toString("base64url");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await store.pool.query(
        `INSERT INTO public.password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
        [user.id, tokenHash, expiresAt.toISOString()]
      );

      const appUrl = process.env.APP_URL ?? "https://openlanternai-dashboard.pages.dev";
      // TODO: Send email via Resend or similar service
      request.log.info({ email, resetUrl: `${appUrl}/reset-password?token=${rawToken}` }, "Password reset requested");
    }

    return reply.send({ success: true });
  }
);
```

- [ ] **Step 4: Add reset-password endpoint**

Add after the forgot-password route:

```typescript
// POST /auth/reset-password — reset password with token
app.post<{ Body: { token: string; password: string } }>(
  "/auth/reset-password",
  async (request, reply) => {
    const { token, password } = request.body;
    if (!token || !password) {
      return reply.status(400).send({ error: "token and password are required" });
    }

    const passwordError = validatePassword(password);
    if (passwordError) {
      return reply.status(400).send({ error: passwordError });
    }

    const { createHash } = await import("node:crypto");
    const tokenHash = createHash("sha256").update(token).digest("hex");

    const { rows } = await store.pool.query(
      `SELECT user_id, expires_at FROM public.password_reset_tokens WHERE token_hash = $1`,
      [tokenHash]
    );

    if (rows.length === 0) {
      return reply.status(400).send({ error: "Invalid or expired reset token" });
    }

    const resetRecord = rows[0];
    if (new Date(resetRecord.expires_at as string) < new Date()) {
      await store.pool.query(`DELETE FROM public.password_reset_tokens WHERE token_hash = $1`, [tokenHash]);
      return reply.status(400).send({ error: "Invalid or expired reset token" });
    }

    const newHash = await hashPassword(password);
    await store.pool.query(`UPDATE public.users SET password_hash = $1 WHERE id = $2`, [newHash, resetRecord.user_id]);
    await store.pool.query(`DELETE FROM public.password_reset_tokens WHERE user_id = $1`, [resetRecord.user_id]);

    return reply.send({ success: true });
  }
);
```

- [ ] **Step 5: Build and verify**

Run: `cd api && pnpm build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/auth.ts api/src/store/tenant-store.ts
git commit -m "feat: add forgot-password and reset-password endpoints"
```

---

### Task 3: Team member management endpoints

**Files:**
- Modify: `api/src/routes/teams.ts`

- [ ] **Step 1: Add GET /teams/my endpoint**

In `api/src/routes/teams.ts`, add inside `registerTeamRoutes()`:

```typescript
// GET /teams/my — get current user's teams
app.get("/teams/my", async (request, reply) => {
  const user = getUser(request);

  // Get user email from users table
  const { rows: userRows } = await pool.query(
    "SELECT email FROM public.users WHERE id = $1",
    [user.sub]
  );
  if (userRows.length === 0) return reply.status(404).send({ error: "User not found" });
  const email = userRows[0].email as string;

  // Find teams the user belongs to (or all teams for the tenant if they have no memberships)
  const { rows: memberTeams } = await pool.query(
    `SELECT DISTINCT t.id, t.name, t.created_at,
       (SELECT COUNT(*)::int FROM public.team_members tm WHERE tm.team_id = t.id) AS member_count
     FROM public.teams t
     JOIN public.team_members tm ON tm.team_id = t.id
     WHERE t.tenant_id = $1 AND tm.user_email = $2
     ORDER BY t.created_at DESC`,
    [user.tenantId, email]
  );

  if (memberTeams.length > 0) {
    return reply.send({ teams: memberTeams.map(t => ({
      id: t.id, name: t.name, memberCount: t.member_count, createdAt: (t.created_at as Date).toISOString()
    })) });
  }

  // No memberships — owners/admins see all teams
  if (user.role === "owner" || user.role === "admin") {
    const { rows: allTeams } = await pool.query(
      `SELECT t.id, t.name, t.created_at,
         (SELECT COUNT(*)::int FROM public.team_members tm WHERE tm.team_id = t.id) AS member_count
       FROM public.teams t WHERE t.tenant_id = $1 ORDER BY t.created_at DESC`,
      [user.tenantId]
    );
    return reply.send({ teams: allTeams.map(t => ({
      id: t.id, name: t.name, memberCount: t.member_count, createdAt: (t.created_at as Date).toISOString()
    })) });
  }

  return reply.send({ teams: [] });
});
```

- [ ] **Step 2: Add GET /teams/:id/members endpoint**

```typescript
// GET /teams/:id/members — detailed member list
app.get<{ Params: { id: string } }>("/teams/:id/members", async (request, reply) => {
  const user = getUser(request);

  // Verify team belongs to tenant
  const { rows: teamRows } = await pool.query(
    "SELECT id FROM public.teams WHERE id = $1 AND tenant_id = $2",
    [request.params.id, user.tenantId]
  );
  if (teamRows.length === 0) return reply.status(404).send({ error: "Team not found" });

  const { rows: members } = await pool.query(
    `SELECT u.id AS user_id, u.email, u.display_name, u.role, tm.created_at AS joined_at
     FROM public.team_members tm
     JOIN public.users u ON u.email = tm.user_email AND u.tenant_id = $2
     WHERE tm.team_id = $1
     ORDER BY tm.created_at ASC`,
    [request.params.id, user.tenantId]
  );

  return reply.send({
    members: members.map(m => ({
      userId: m.user_id as string,
      email: m.email as string,
      displayName: (m.display_name as string) ?? null,
      role: m.role as string,
      joinedAt: (m.joined_at as Date).toISOString(),
    }))
  });
});
```

- [ ] **Step 3: Add POST /teams/:id/members endpoint (invite)**

```typescript
// POST /teams/:id/members — invite member
app.post<{ Params: { id: string }; Body: { email: string } }>("/teams/:id/members", async (request, reply) => {
  const user = getUser(request);
  if (user.role !== "owner" && user.role !== "admin") {
    return reply.status(403).send({ error: "Only owners and admins can invite members" });
  }

  const { email } = request.body;
  if (!email) return reply.status(400).send({ error: "email is required" });

  // Verify team belongs to tenant
  const { rows: teamRows } = await pool.query(
    "SELECT id FROM public.teams WHERE id = $1 AND tenant_id = $2",
    [request.params.id, user.tenantId]
  );
  if (teamRows.length === 0) return reply.status(404).send({ error: "Team not found" });

  // Check if user already exists in tenant
  let targetUser = await pool.query(
    "SELECT id, email, role FROM public.users WHERE email = $1 AND tenant_id = $2",
    [email, user.tenantId]
  );

  if (targetUser.rows.length === 0) {
    // Create new user with random password
    const { randomBytes } = await import("node:crypto");
    const { hashPassword } = await import("../lib/passwords.js");
    const tempPassword = randomBytes(24).toString("base64url");
    const passwordHash = await hashPassword(tempPassword);

    await pool.query(
      `INSERT INTO public.users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, 'member')`,
      [user.tenantId, email, passwordHash]
    );
    targetUser = await pool.query(
      "SELECT id, email, role FROM public.users WHERE email = $1 AND tenant_id = $2",
      [email, user.tenantId]
    );

    // TODO: Send invite email with password reset link
    request.log.info({ email }, "New user created via team invite — needs password reset");
  }

  // Add to team (ignore if already a member)
  await pool.query(
    `INSERT INTO public.team_members (id, team_id, user_email) VALUES (gen_random_uuid(), $1, $2) ON CONFLICT DO NOTHING`,
    [request.params.id, email]
  );

  return reply.status(201).send({
    userId: targetUser.rows[0].id as string,
    email: targetUser.rows[0].email as string,
    role: targetUser.rows[0].role as string,
  });
});
```

- [ ] **Step 4: Add PUT /teams/:id/members/:userId (role update) and DELETE (remove)**

```typescript
// PUT /teams/:id/members/:userId — update role
app.put<{ Params: { id: string; userId: string }; Body: { role: string } }>(
  "/teams/:id/members/:userId",
  async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "owner") {
      return reply.status(403).send({ error: "Only owners can change roles" });
    }

    const { role } = request.body;
    if (!role || !["admin", "member"].includes(role)) {
      return reply.status(400).send({ error: "role must be 'admin' or 'member'" });
    }

    // Cannot change owner's role
    const { rows: targetRows } = await pool.query(
      "SELECT role FROM public.users WHERE id = $1 AND tenant_id = $2",
      [request.params.userId, user.tenantId]
    );
    if (targetRows.length === 0) return reply.status(404).send({ error: "User not found" });
    if (targetRows[0].role === "owner") return reply.status(403).send({ error: "Cannot change owner's role" });

    await pool.query("UPDATE public.users SET role = $1 WHERE id = $2", [role, request.params.userId]);
    return reply.send({ userId: request.params.userId, role });
  }
);

// DELETE /teams/:id/members/:userId — remove from team
app.delete<{ Params: { id: string; userId: string } }>(
  "/teams/:id/members/:userId",
  async (request, reply) => {
    const user = getUser(request);
    if (user.role !== "owner" && user.role !== "admin") {
      return reply.status(403).send({ error: "Only owners and admins can remove members" });
    }

    // Get target user email and role
    const { rows: targetRows } = await pool.query(
      "SELECT email, role FROM public.users WHERE id = $1 AND tenant_id = $2",
      [request.params.userId, user.tenantId]
    );
    if (targetRows.length === 0) return reply.status(404).send({ error: "User not found" });
    if (targetRows[0].role === "owner") return reply.status(403).send({ error: "Cannot remove the owner" });

    await pool.query(
      "DELETE FROM public.team_members WHERE team_id = $1 AND user_email = $2",
      [request.params.id, targetRows[0].email]
    );
    return reply.send({ removed: true });
  }
);
```

- [ ] **Step 5: Build and verify**

Run: `cd api && pnpm build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/teams.ts
git commit -m "feat: team member management endpoints (list, invite, role update, remove)"
```

---

### Task 4: Fix billing/status response to include limits

**Files:**
- Modify: `api/src/routes/billing.ts`

The enterprise API's `GET /billing/status` returns `{ plan, subscription, usage }` but the dashboard needs `limits` (tracesPerMonth, used, remaining, percentUsed) for the usage bar on the Settings page.

- [ ] **Step 1: Add limits to billing/status response**

In `api/src/routes/billing.ts`, update the `GET /billing/status` handler. Replace the final `reply.send(...)` with:

```typescript
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
```

- [ ] **Step 2: Build and verify**

Run: `cd api && pnpm build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/billing.ts
git commit -m "feat: add limits to billing/status response"
```

---

### Task 5: GET /scorecards/sla endpoint (register before GET /scorecards/:agentName)

**Files:**
- Modify: `api/src/routes/scorecards.ts`

- [ ] **Step 1: Add GET /scorecards/sla endpoint**

In `api/src/routes/scorecards.ts`, add inside `registerScorecardRoutes()` before the existing `POST /scorecards/sla`:

```typescript
// GET /scorecards/sla — list all SLA targets for tenant
app.get("/scorecards/sla", async (request, reply) => {
  const user = getUser(request);
  try {
    const { rows } = await pool.query(
      `SELECT id, agent_name, min_success_rate, max_p95_latency_ms, max_cost_per_trace, created_at
       FROM public.sla_targets WHERE tenant_id = $1 ORDER BY agent_name`,
      [user.tenantId]
    );
    return reply.send({
      targets: rows.map(row => ({
        id: row.id as string,
        agentName: row.agent_name as string,
        minSuccessRate: row.min_success_rate as number | null,
        maxP95LatencyMs: row.max_p95_latency_ms as number | null,
        maxCostPerTrace: row.max_cost_per_trace as number | null,
        createdAt: (row.created_at as Date).toISOString(),
      }))
    });
  } catch (error) {
    request.log.error(error);
    return reply.status(500).send({ error: "Failed to list SLA targets" });
  }
});
```

**Important:** This must be registered BEFORE `GET /scorecards/:agentName` (which is a parameterized route that could match "sla"). Fastify v4 handles static-vs-parameterized correctly, but register it early for clarity — add it right after the existing `GET /scorecards` route and before `GET /scorecards/:agentName`.

- [ ] **Step 2: Build and verify**

Run: `cd api && pnpm build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add api/src/routes/scorecards.ts
git commit -m "feat: add GET /scorecards/sla endpoint to list SLA targets"
```

---

### Task 6: Add security headers to enterprise API server

**Files:**
- Modify: `api/src/server.ts`

The enterprise API server currently only sets `X-Content-Type-Options` and `X-Frame-Options`. Add the same security headers as the OSS API, but omit CSP since this server only serves JSON responses (CSP is only enforced on HTML documents).

- [ ] **Step 1: Add security headers**

In `api/src/server.ts`, update the `onSend` hook:

```typescript
app.addHook("onSend", async (_request, reply) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
});
```

- [ ] **Step 2: Build and verify**

Run: `cd api && pnpm build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add api/src/server.ts
git commit -m "fix: add security headers to enterprise API server"
```

---

## Chunk 2: Dashboard SPA Shell

All files in this chunk are created in `dashboard/` within the enterprise repo.

### Task 6: Scaffold Vite + React project

**Files:**
- Create: `dashboard/package.json`
- Create: `dashboard/vite.config.ts`
- Create: `dashboard/tsconfig.json`
- Create: `dashboard/index.html`
- Create: `dashboard/public/_redirects`

- [ ] **Step 1: Create dashboard/package.json**

```json
{
  "name": "@lantern-ai/dashboard",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "react-router-dom": "^6.22.0"
  },
  "devDependencies": {
    "@testing-library/react": "^14.2.0",
    "@testing-library/jest-dom": "^6.4.0",
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "@vitejs/plugin-react": "^4.2.0",
    "jsdom": "^24.0.0",
    "typescript": "^5.4.0",
    "vite": "^5.4.0",
    "vitest": "^1.4.0"
  }
}
```

- [ ] **Step 2: Create dashboard/vite.config.ts**

```typescript
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
  },
});
```

- [ ] **Step 3: Create dashboard/tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

- [ ] **Step 4: Create dashboard/index.html**

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lantern — Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 5: Create dashboard/public/_redirects**

```
/* /index.html 200
```

- [ ] **Step 6: Install dependencies**

Run: `cd dashboard && npm install`
Expected: `node_modules/` created, no errors

- [ ] **Step 7: Commit**

```bash
git add dashboard/package.json dashboard/vite.config.ts dashboard/tsconfig.json dashboard/index.html dashboard/public/_redirects
git commit -m "feat: scaffold dashboard Vite + React project"
```

---

### Task 7: Theme CSS and shared types

**Files:**
- Create: `dashboard/src/theme.css`
- Create: `dashboard/src/lib/types.ts`

- [ ] **Step 1: Create dashboard/src/theme.css**

```css
:root {
  --bg: #0f1117;
  --surface: #1a1d27;
  --surface2: #232734;
  --border: #2e3345;
  --text: #e1e4ed;
  --text-dim: #8b91a5;
  --accent: #6c8cff;
  --accent-dim: #3d5199;
  --green: #34d399;
  --red: #f87171;
  --yellow: #fbbf24;
  --orange: #fb923c;
  --purple: #a78bfa;
  --cyan: #22d3ee;
  --font: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", "Fira Code", "SF Mono", Consolas, monospace;
}

* {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

body {
  font-family: var(--font);
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  min-height: 100vh;
}

a {
  color: var(--accent);
  text-decoration: none;
}

button {
  font-family: var(--font);
  cursor: pointer;
}

input, select, textarea {
  font-family: var(--font);
}
```

- [ ] **Step 2: Create dashboard/src/lib/types.ts**

```typescript
export interface Trace {
  id: string;
  sessionId: string;
  agentName: string;
  agentVersion?: string;
  environment: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  status: "success" | "error" | "running";
  totalInputTokens: number;
  totalOutputTokens: number;
  estimatedCostUsd: number;
  metadata: Record<string, unknown>;
  source?: TraceSource;
  spans: Span[];
  scores?: EvalScore[];
}

export interface TraceSource {
  serviceName: string;
  sdkVersion?: string;
  exporterType?: string;
}

export interface Span {
  id: string;
  parentSpanId?: string;
  type: "llm_call" | "tool_call" | "retrieval" | "reasoning_step" | "custom";
  model?: string;
  toolName?: string;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  input?: SpanInput;
  output?: SpanOutput;
  error?: string;
}

export interface SpanInput {
  messages?: Array<{ role: string; content: string }>;
  prompt?: string;
  args?: Record<string, unknown>;
}

export interface SpanOutput {
  content?: string;
  toolCalls?: unknown[];
}

export interface EvalScore {
  scorer: string;
  score: number;
  label?: string;
}

export interface SourceSummary {
  serviceName: string;
  sdkVersion?: string;
  exporterType?: string;
  traceCount: number;
  lastSeen: number;
  environments: string[];
  agents: string[];
}

export interface AgentScorecard {
  agentName: string;
  totalTraces: number;
  successRate: number;
  errorRate: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  avgCostPerTrace: number;
  totalCost: number;
  qualityTrend: "improving" | "stable" | "declining";
}

export interface SlaTarget {
  id: string;
  agentName: string;
  minSuccessRate: number | null;
  maxP95LatencyMs: number | null;
  maxCostPerTrace: number | null;
  createdAt: string;
}

export interface SlaViolation {
  agentName: string;
  sla: SlaTarget;
  current: {
    successRate: number;
    p95LatencyMs: number;
    avgCostPerTrace: number;
  };
  violations: string[];
}

export interface RegressionFlag {
  metric: string;
  baselineValue: number;
  currentValue: number;
  changePercent: number;
}

export interface RegressionCheckResult {
  agentName: string;
  baselineMetrics: Record<string, number>;
  currentMetrics: Record<string, number>;
  regressions: RegressionFlag[];
  hasRegression: boolean;
}

export interface TeamMember {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  joinedAt: string;
}

export interface ApiKeyRecord {
  id: string;
  keyPrefix: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export interface BillingStatus {
  plan: string;
  subscription: {
    status: string;
    currentPeriodEnd: string;
    cancelAtPeriodEnd: boolean;
  } | null;
  usage: {
    traceCount: number;
    inputTokens: number;
    outputTokens: number;
  };
  limits: {
    tracesPerMonth: number;
    used: number;
    remaining: number;
    percentUsed: number;
  };
}

export interface AuthUser {
  sub: string;
  email: string;
  tenantId: string;
  tenantSlug: string;
  role: string;
  exp: number;
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/theme.css dashboard/src/lib/types.ts
git commit -m "feat: add theme CSS and shared TypeScript types"
```

---

### Task 8: API client and auth context

**Files:**
- Create: `dashboard/src/lib/api.ts`
- Create: `dashboard/src/lib/auth.tsx`

- [ ] **Step 1: Create dashboard/src/lib/api.ts**

```typescript
import type { AuthUser } from "./types.js";

const API_URL = import.meta.env.VITE_API_URL ?? "http://localhost:4200";

let getToken: () => string | null = () => null;
let onUnauthorized: () => void = () => {};

export function configureApi(opts: { getToken: () => string | null; onUnauthorized: () => void }) {
  getToken = opts.getToken;
  onUnauthorized = opts.onUnauthorized;
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init?.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const response = await fetch(`${API_URL}${path}`, { ...init, headers });

  if (response.status === 401) {
    onUnauthorized();
    throw new Error("Unauthorized");
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error ?? `API error: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function decodeJwt(token: string): AuthUser {
  const payload = token.split(".")[1];
  // Handle base64url encoding (replace URL-safe chars before decoding)
  const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
  const decoded = JSON.parse(atob(base64));
  return decoded as AuthUser;
}
```

- [ ] **Step 2: Create dashboard/src/lib/auth.tsx**

```tsx
import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from "react";
import { apiFetch, configureApi, decodeJwt } from "./api.js";
import type { AuthUser } from "./types.js";

interface AuthState {
  token: string | null;
  user: (AuthUser & { email: string }) | null;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>(() => {
    const token = sessionStorage.getItem("lantern_token");
    const userJson = sessionStorage.getItem("lantern_user");
    if (token && userJson) {
      try {
        const user = JSON.parse(userJson);
        // Check if token is expired
        if (user.exp * 1000 > Date.now()) {
          return { token, user };
        }
      } catch {}
    }
    return { token: null, user: null };
  });

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout>>();

  const logout = useCallback(() => {
    sessionStorage.removeItem("lantern_token");
    sessionStorage.removeItem("lantern_user");
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    setState({ token: null, user: null });
  }, []);

  const scheduleRefresh = useCallback((token: string, user: AuthUser) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const msUntilExpiry = user.exp * 1000 - Date.now();
    const refreshIn = Math.max(0, msUntilExpiry - 60 * 60 * 1000); // 1 hour before expiry
    refreshTimerRef.current = setTimeout(async () => {
      try {
        const data = await apiFetch<{ token: string }>("/auth/refresh", { method: "POST" });
        const newUser = decodeJwt(data.token);
        const enrichedUser = { ...newUser, email: user.email };
        sessionStorage.setItem("lantern_token", data.token);
        sessionStorage.setItem("lantern_user", JSON.stringify(enrichedUser));
        setState({ token: data.token, user: enrichedUser });
        scheduleRefresh(data.token, enrichedUser);
      } catch {
        // Refresh failed — user will be logged out on next 401
      }
    }, refreshIn);
  }, []);

  // Configure API client with auth
  useEffect(() => {
    configureApi({ getToken: () => state.token, onUnauthorized: logout });
  }, [state.token, logout]);

  // Schedule token refresh on mount/login
  useEffect(() => {
    if (state.token && state.user) {
      scheduleRefresh(state.token, state.user);
    }
    return () => { if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current); };
  }, [state.token, state.user, scheduleRefresh]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiFetch<{ token: string; user: { id: string; email: string; role: string } }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }) }
    );
    const decoded = decodeJwt(data.token);
    const user = { ...decoded, email: data.user.email };
    sessionStorage.setItem("lantern_token", data.token);
    sessionStorage.setItem("lantern_user", JSON.stringify(user));
    setState({ token: data.token, user });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/lib/api.ts dashboard/src/lib/auth.tsx
git commit -m "feat: add API client with JWT auth and token refresh"
```

---

### Task 9: Shared UI components

**Files:**
- Create: `dashboard/src/components/Sidebar.tsx`
- Create: `dashboard/src/components/Sidebar.module.css`
- Create: `dashboard/src/components/PageHeader.tsx`
- Create: `dashboard/src/components/StatCard.tsx`
- Create: `dashboard/src/components/DataTable.tsx`
- Create: `dashboard/src/components/Badge.tsx`
- Create: `dashboard/src/components/Modal.tsx`
- Create: `dashboard/src/components/EmptyState.tsx`
- Create: `dashboard/src/components/LoadingSpinner.tsx`
- Create: `dashboard/src/components/FilterChips.tsx`
- Create: `dashboard/src/components/components.module.css`

- [ ] **Step 1: Create Sidebar component**

Create `dashboard/src/components/Sidebar.tsx`:

```tsx
import React from "react";
import { NavLink } from "react-router-dom";
import { useAuth } from "../lib/auth.js";
import styles from "./Sidebar.module.css";

interface NavItem {
  label: string;
  to: string;
  badge?: string;
}

interface NavSection {
  header?: string;
  items: NavItem[];
  separator?: boolean;
}

const sections: NavSection[] = [
  {
    header: "Observe",
    items: [
      { label: "Traces", to: "/traces" },
      { label: "Sources", to: "/sources" },
    ],
  },
  {
    header: "Quality",
    items: [
      { label: "Scorecards", to: "/scorecards" },
      { label: "Regressions", to: "/regressions" },
    ],
  },
  {
    header: "Costs",
    items: [
      { label: "Breakdown", to: "/costs", badge: "Soon" },
      { label: "Forecast", to: "/costs/forecast", badge: "Soon" },
    ],
  },
  {
    header: "Security",
    items: [
      { label: "PII Scanner", to: "/pii", badge: "Soon" },
      { label: "Compliance", to: "/compliance", badge: "Soon" },
    ],
  },
  {
    header: "Alerts",
    items: [
      { label: "Alert History", to: "/alerts", badge: "Soon" },
      { label: "Channels", to: "/alerts/channels", badge: "Soon" },
    ],
  },
  {
    separator: true,
    items: [
      { label: "Team Members", to: "/settings/team" },
      { label: "API Keys", to: "/settings/api-keys" },
      { label: "Settings", to: "/settings" },
    ],
  },
];

export const Sidebar: React.FC = () => {
  const { user, logout } = useAuth();

  return (
    <aside className={styles.sidebar}>
      <div className={styles.logo}>
        <div className={styles.logoIcon}>&#9678;</div>
        <span>Lantern</span>
      </div>
      {user && <div className={styles.tenant}>{user.tenantSlug}</div>}

      <nav className={styles.nav}>
        {sections.map((section, i) => (
          <div key={i} className={styles.section}>
            {section.separator && <div className={styles.separator} />}
            {section.header && <div className={styles.sectionHeader}>{section.header}</div>}
            {section.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                className={({ isActive }) => `${styles.navItem} ${isActive ? styles.active : ""}`}
              >
                {item.label}
                {item.badge && <span className={styles.badge}>{item.badge}</span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className={styles.footer}>
        {user && <div className={styles.email}>{user.email}</div>}
        <button onClick={logout} className={styles.logoutBtn}>Log out</button>
      </div>
    </aside>
  );
};
```

Create `dashboard/src/components/Sidebar.module.css`:

```css
.sidebar {
  width: 220px;
  min-width: 220px;
  background: var(--surface);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  height: 100vh;
  position: sticky;
  top: 0;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 20px 16px 8px;
  font-size: 18px;
  font-weight: 700;
}

.logoIcon {
  width: 24px;
  height: 24px;
  background: linear-gradient(135deg, var(--accent), var(--purple));
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
}

.tenant {
  padding: 0 16px 16px;
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--mono);
}

.nav {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px;
}

.section {
  margin-bottom: 4px;
}

.sectionHeader {
  font-size: 10px;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 12px 10px 4px;
}

.separator {
  height: 1px;
  background: var(--border);
  margin: 8px 10px;
}

.navItem {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--text-dim);
  text-decoration: none;
  transition: all 0.15s;
}

.navItem:hover {
  background: var(--surface2);
  color: var(--text);
}

.active {
  background: rgba(108, 140, 255, 0.12);
  color: var(--accent);
  font-weight: 600;
}

.badge {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 8px;
  background: var(--surface2);
  color: var(--text-dim);
}

.footer {
  padding: 16px;
  border-top: 1px solid var(--border);
}

.email {
  font-size: 12px;
  color: var(--text-dim);
  margin-bottom: 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.logoutBtn {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-dim);
  padding: 6px 12px;
  border-radius: 6px;
  font-size: 12px;
  width: 100%;
  transition: all 0.15s;
}

.logoutBtn:hover {
  border-color: var(--red);
  color: var(--red);
}
```

- [ ] **Step 2: Create remaining shared components**

Create `dashboard/src/components/components.module.css`:

```css
/* PageHeader */
.pageHeader { margin-bottom: 24px; }
.pageTitle { font-size: 20px; font-weight: 700; }
.pageDescription { color: var(--text-dim); font-size: 14px; margin-top: 4px; }
.pageActions { display: flex; gap: 8px; margin-top: 12px; }

/* StatCard */
.statCard { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 14px; }
.statLabel { font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; }
.statValue { font-size: 22px; font-weight: 700; margin-top: 2px; }

/* DataTable */
.table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
.table th { padding: 10px 14px; text-align: left; font-size: 11px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid var(--border); cursor: pointer; user-select: none; }
.table th:hover { color: var(--text); }
.table td { padding: 10px 14px; font-size: 13px; border-bottom: 1px solid var(--border); }
.table tr:last-child td { border-bottom: none; }
.table tr:hover td { background: var(--surface2); }
.clickableRow { cursor: pointer; }

/* Badge */
.badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; }
.badgeSuccess { background: rgba(52, 211, 153, 0.15); color: var(--green); }
.badgeError { background: rgba(248, 113, 113, 0.15); color: var(--red); }
.badgeWarning { background: rgba(251, 191, 36, 0.15); color: var(--yellow); }
.badgeInfo { background: rgba(108, 140, 255, 0.12); color: var(--accent); }
.badgeNeutral { background: var(--surface2); color: var(--text-dim); }

/* Modal */
.modalOverlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; z-index: 100; }
.modal { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 24px; min-width: 400px; max-width: 500px; }
.modalTitle { font-size: 18px; font-weight: 700; margin-bottom: 16px; }
.modalActions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 20px; }

/* Buttons */
.btn { padding: 8px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; border: 1px solid var(--border); background: var(--surface2); color: var(--text); transition: all 0.15s; }
.btn:hover { border-color: var(--accent); }
.btnPrimary { background: var(--accent); border-color: var(--accent); color: #fff; }
.btnPrimary:hover { background: var(--accent-dim); }
.btnDanger { border-color: var(--red); color: var(--red); background: none; }
.btnDanger:hover { background: rgba(248, 113, 113, 0.1); }

/* EmptyState */
.emptyState { display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 60px 20px; color: var(--text-dim); }
.emptyTitle { font-size: 16px; font-weight: 600; color: var(--text); margin-bottom: 8px; }
.emptyDescription { font-size: 14px; text-align: center; max-width: 400px; }

/* LoadingSpinner */
.spinner { display: flex; align-items: center; justify-content: center; padding: 40px; color: var(--text-dim); }

/* FilterChips */
.filterChips { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { padding: 4px 12px; border: 1px solid var(--border); border-radius: 16px; background: none; color: var(--text-dim); font-size: 12px; cursor: pointer; transition: all 0.15s; }
.chip:hover { border-color: var(--accent); color: var(--text); }
.chipActive { border-color: var(--accent); background: rgba(108, 140, 255, 0.12); color: var(--accent); }

/* Form elements */
.input { width: 100%; padding: 8px 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; color: var(--text); font-size: 13px; }
.input:focus { outline: none; border-color: var(--accent); }
.label { display: block; font-size: 12px; color: var(--text-dim); margin-bottom: 4px; font-weight: 600; }
.formGroup { margin-bottom: 16px; }

/* Alert banner */
.alertBanner { padding: 10px 16px; border-radius: 6px; font-size: 13px; display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.alertError { background: rgba(248, 113, 113, 0.08); border: 1px solid rgba(248, 113, 113, 0.2); color: var(--red); }
.alertWarning { background: rgba(251, 191, 36, 0.08); border: 1px solid rgba(251, 191, 36, 0.2); color: var(--yellow); }
.alertSuccess { background: rgba(52, 211, 153, 0.08); border: 1px solid rgba(52, 211, 153, 0.2); color: var(--green); }
```

Create `dashboard/src/components/PageHeader.tsx`:

```tsx
import React from "react";
import styles from "./components.module.css";

interface Props {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export const PageHeader: React.FC<Props> = ({ title, description, actions }) => (
  <div className={styles.pageHeader}>
    <h1 className={styles.pageTitle}>{title}</h1>
    {description && <p className={styles.pageDescription}>{description}</p>}
    {actions && <div className={styles.pageActions}>{actions}</div>}
  </div>
);
```

Create `dashboard/src/components/StatCard.tsx`:

```tsx
import React from "react";
import styles from "./components.module.css";

interface Props {
  label: string;
  value: string | number;
  color?: string;
}

export const StatCard: React.FC<Props> = ({ label, value, color }) => (
  <div className={styles.statCard}>
    <div className={styles.statLabel}>{label}</div>
    <div className={styles.statValue} style={color ? { color } : undefined}>{value}</div>
  </div>
);
```

Create `dashboard/src/components/Badge.tsx`:

```tsx
import React from "react";
import styles from "./components.module.css";

type Variant = "success" | "error" | "warning" | "info" | "neutral";

const variantClass: Record<Variant, string> = {
  success: styles.badgeSuccess,
  error: styles.badgeError,
  warning: styles.badgeWarning,
  info: styles.badgeInfo,
  neutral: styles.badgeNeutral,
};

interface Props {
  variant: Variant;
  children: React.ReactNode;
}

export const Badge: React.FC<Props> = ({ variant, children }) => (
  <span className={`${styles.badge} ${variantClass[variant]}`}>{children}</span>
);
```

Create `dashboard/src/components/Modal.tsx`:

```tsx
import React, { useEffect } from "react";
import styles from "./components.module.css";

interface Props {
  title: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  onClose?: () => void;
}

export const Modal: React.FC<Props> = ({ title, children, actions, onClose }) => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape" && onClose) onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.modalTitle}>{title}</h2>
        {children}
        {actions && <div className={styles.modalActions}>{actions}</div>}
      </div>
    </div>
  );
};
```

Create `dashboard/src/components/EmptyState.tsx`:

```tsx
import React from "react";
import styles from "./components.module.css";

interface Props { title: string; description: string; action?: React.ReactNode; }

export const EmptyState: React.FC<Props> = ({ title, description, action }) => (
  <div className={styles.emptyState}>
    <div className={styles.emptyTitle}>{title}</div>
    <div className={styles.emptyDescription}>{description}</div>
    {action && <div style={{ marginTop: 16 }}>{action}</div>}
  </div>
);
```

Create `dashboard/src/components/LoadingSpinner.tsx`:

```tsx
import React from "react";
import styles from "./components.module.css";

export const LoadingSpinner: React.FC = () => (
  <div className={styles.spinner}>Loading...</div>
);
```

Create `dashboard/src/components/FilterChips.tsx`:

```tsx
import React from "react";
import styles from "./components.module.css";

interface Props {
  options: string[];
  selected: string;
  onSelect: (value: string) => void;
}

export const FilterChips: React.FC<Props> = ({ options, selected, onSelect }) => (
  <div className={styles.filterChips}>
    {options.map((opt) => (
      <button
        key={opt}
        className={`${styles.chip} ${selected === opt ? styles.chipActive : ""}`}
        onClick={() => onSelect(opt)}
      >
        {opt}
      </button>
    ))}
  </div>
);
```

Create `dashboard/src/components/DataTable.tsx`:

```tsx
import React, { useState } from "react";
import styles from "./components.module.css";

interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sortable?: boolean;
  sortValue?: (row: T) => number | string;
}

interface Props<T> {
  columns: Column<T>[];
  data: T[];
  onRowClick?: (row: T) => void;
  keyExtractor: (row: T) => string;
}

export function DataTable<T>({ columns, data, onRowClick, keyExtractor }: Props<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const handleSort = (col: Column<T>) => {
    if (!col.sortable) return;
    if (sortKey === col.key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(col.key);
      setSortDir("asc");
    }
  };

  const sorted = [...data];
  if (sortKey) {
    const col = columns.find((c) => c.key === sortKey);
    if (col?.sortValue) {
      sorted.sort((a, b) => {
        const va = col.sortValue!(a);
        const vb = col.sortValue!(b);
        const cmp = va < vb ? -1 : va > vb ? 1 : 0;
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
  }

  return (
    <table className={styles.table}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key} onClick={() => handleSort(col)}>
              {col.header}
              {sortKey === col.key && (sortDir === "asc" ? " ↑" : " ↓")}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.map((row) => (
          <tr
            key={keyExtractor(row)}
            className={onRowClick ? styles.clickableRow : undefined}
            onClick={() => onRowClick?.(row)}
          >
            {columns.map((col) => (
              <td key={col.key}>{col.render(row)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/
git commit -m "feat: add shared UI components (sidebar, table, modal, badges, etc.)"
```

---

### Task 10: App shell with routing

**Files:**
- Create: `dashboard/src/main.tsx`
- Create: `dashboard/src/app.tsx`
- Create: `dashboard/src/app.module.css`
- Create: `dashboard/src/features/auth/LoginPage.tsx`
- Create: `dashboard/src/features/auth/LoginPage.module.css`

- [ ] **Step 1: Create main.tsx**

```tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import "./theme.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
```

- [ ] **Step 2: Create app.tsx with routing**

```tsx
import React from "react";
import { BrowserRouter, Routes, Route, Navigate, Outlet } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth.js";
import { Sidebar } from "./components/Sidebar.js";
import { LoginPage } from "./features/auth/LoginPage.js";
import { LoadingSpinner } from "./components/LoadingSpinner.js";
import styles from "./app.module.css";

// Lazy load feature pages
const TracesPage = React.lazy(() => import("./features/traces/TracesPage.js"));
const TraceDetailPage = React.lazy(() => import("./features/traces/TraceDetailPage.js"));
const SourcesPage = React.lazy(() => import("./features/traces/SourcesPage.js"));
const ScorecardsPage = React.lazy(() => import("./features/quality/ScorecardsPage.js"));
const RegressionsPage = React.lazy(() => import("./features/quality/RegressionsPage.js"));
const SettingsPage = React.lazy(() => import("./features/settings/SettingsPage.js"));
const TeamPage = React.lazy(() => import("./features/settings/TeamPage.js"));
const ApiKeysPage = React.lazy(() => import("./features/settings/ApiKeysPage.js"));

function RequireAuth() {
  const { token } = useAuth();
  if (!token) return <Navigate to="/login" replace />;
  return (
    <div className={styles.layout}>
      <Sidebar />
      <main className={styles.main}>
        <React.Suspense fallback={<LoadingSpinner />}>
          <Outlet />
        </React.Suspense>
      </main>
    </div>
  );
}

export const App: React.FC = () => (
  <BrowserRouter>
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route element={<RequireAuth />}>
          <Route path="/traces" element={<TracesPage />} />
          <Route path="/traces/:id" element={<TraceDetailPage />} />
          <Route path="/sources" element={<SourcesPage />} />
          <Route path="/scorecards" element={<ScorecardsPage />} />
          <Route path="/regressions" element={<RegressionsPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/team" element={<TeamPage />} />
          <Route path="/settings/api-keys" element={<ApiKeysPage />} />
          <Route path="*" element={<Navigate to="/traces" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  </BrowserRouter>
);
```

Create `dashboard/src/app.module.css`:

```css
.layout {
  display: flex;
  min-height: 100vh;
}

.main {
  flex: 1;
  overflow-y: auto;
  padding: 24px 32px;
}
```

- [ ] **Step 3: Create LoginPage**

Create `dashboard/src/features/auth/LoginPage.tsx`:

```tsx
import React, { useState } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../../lib/auth.js";
import styles from "./LoginPage.module.css";
import cStyles from "../../components/components.module.css";

export function LoginPage() {
  const { token, login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  if (token) return <Navigate to="/traces" replace />;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await login(email, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={styles.container}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.logo}>
          <div className={styles.logoIcon}>&#9678;</div>
          <span>Lantern</span>
        </div>
        <p className={styles.subtitle}>Sign in to your dashboard</p>

        {error && <div className={`${cStyles.alertBanner} ${cStyles.alertError}`}>{error}</div>}

        <div className={cStyles.formGroup}>
          <label className={cStyles.label}>Email</label>
          <input className={cStyles.input} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>

        <div className={cStyles.formGroup}>
          <label className={cStyles.label}>Password</label>
          <input className={cStyles.input} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>

        <button className={`${cStyles.btn} ${cStyles.btnPrimary}`} type="submit" disabled={loading} style={{ width: "100%" }}>
          {loading ? "Signing in..." : "Sign In"}
        </button>
      </form>
    </div>
  );
}
```

Create `dashboard/src/features/auth/LoginPage.module.css`:

```css
.container {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg);
}

.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 32px;
  width: 380px;
}

.logo {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 4px;
}

.logoIcon {
  width: 28px;
  height: 28px;
  background: linear-gradient(135deg, var(--accent), var(--purple));
  border-radius: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
}

.subtitle {
  color: var(--text-dim);
  font-size: 14px;
  margin-bottom: 24px;
}
```

- [ ] **Step 4: Create placeholder page files for lazy imports**

Each feature page needs a default export for `React.lazy()`. Create minimal placeholder files:

Create `dashboard/src/features/traces/TracesPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function TracesPage() { return <PageHeader title="Traces" description="View and filter agent traces" />; }
```

Create `dashboard/src/features/traces/TraceDetailPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function TraceDetailPage() { return <PageHeader title="Trace Detail" />; }
```

Create `dashboard/src/features/traces/SourcesPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function SourcesPage() { return <PageHeader title="Sources" description="Connected data sources" />; }
```

Create `dashboard/src/features/quality/ScorecardsPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function ScorecardsPage() { return <PageHeader title="Scorecards" description="Agent performance overview" />; }
```

Create `dashboard/src/features/quality/RegressionsPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function RegressionsPage() { return <PageHeader title="Regressions" description="Behavioral regression detection" />; }
```

Create `dashboard/src/features/settings/SettingsPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function SettingsPage() { return <PageHeader title="Settings" description="Account settings and preferences" />; }
```

Create `dashboard/src/features/settings/TeamPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function TeamPage() { return <PageHeader title="Team Members" description="Manage your team" />; }
```

Create `dashboard/src/features/settings/ApiKeysPage.tsx`:
```tsx
import React from "react";
import { PageHeader } from "../../components/PageHeader.js";
export default function ApiKeysPage() { return <PageHeader title="API Keys" description="Manage API keys for programmatic access" />; }
```

- [ ] **Step 5: Build and verify the shell runs**

Run: `cd dashboard && npm run build`
Expected: Clean build, `dist/` directory created

Run: `cd dashboard && npm run dev`
Expected: Vite dev server starts on port 3000. Visit `http://localhost:3000` — should show login page.

- [ ] **Step 6: Commit**

```bash
git add dashboard/src/main.tsx dashboard/src/app.tsx dashboard/src/app.module.css dashboard/src/features/
git commit -m "feat: app shell with routing, login page, and placeholder feature pages"
```

---

## Chunk 3: Feature Pages — Quality

### Task 11: Quality feature API module

**Files:**
- Create: `dashboard/src/features/quality/api.ts`

- [ ] **Step 1: Create quality API module**

```typescript
import { apiFetch } from "../../lib/api.js";
import type { AgentScorecard, SlaTarget, SlaViolation, RegressionCheckResult } from "../../lib/types.js";

export async function fetchScorecards(period: number, environment?: string) {
  const params = new URLSearchParams({ period: String(period) });
  if (environment) params.set("environment", environment);
  return apiFetch<{ period: number; scorecards: AgentScorecard[] }>(`/scorecards?${params}`);
}

export async function fetchAgentScorecard(agentName: string, period: number, environment?: string) {
  const params = new URLSearchParams({ period: String(period) });
  if (environment) params.set("environment", environment);
  return apiFetch<{ agentName: string; period: number; summary: AgentScorecard; daily: unknown[] }>(
    `/scorecards/${encodeURIComponent(agentName)}?${params}`
  );
}

export async function fetchSlaTargets() {
  return apiFetch<{ targets: SlaTarget[] }>("/scorecards/sla");
}

export async function fetchSlaViolations(period: number, environment?: string) {
  const params = new URLSearchParams({ period: String(period) });
  if (environment) params.set("environment", environment);
  return apiFetch<{ period: number; violations: SlaViolation[] }>(`/scorecards/sla/violations?${params}`);
}

export async function setSlaTarget(body: { agentName: string; minSuccessRate?: number; maxP95LatencyMs?: number; maxCostPerTrace?: number }) {
  return apiFetch<{ slaTarget: SlaTarget }>("/scorecards/sla", { method: "POST", body: JSON.stringify(body) });
}

export async function runRegressionCheck() {
  return apiFetch<{ checkedAt: string; agentCount: number; regressionsFound: number; agents: RegressionCheckResult[] }>("/regressions/check");
}

export async function fetchRegressionHistory(opts?: { limit?: number; offset?: number; agentName?: string }) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.agentName) params.set("agentName", opts.agentName);
  return apiFetch<{ events: unknown[]; total: number; limit: number; offset: number }>(`/regressions/history?${params}`);
}

export async function snapshotBaseline(agentName: string) {
  return apiFetch<{ agentName: string; snapshotAt: string; traceCount: number; baseline: Record<string, number> }>(
    `/regressions/baseline/${encodeURIComponent(agentName)}`,
    { method: "POST" }
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/features/quality/api.ts
git commit -m "feat: quality feature API module"
```

---

### Task 12: Scorecards page

**Files:**
- Rewrite: `dashboard/src/features/quality/ScorecardsPage.tsx`
- Create: `dashboard/src/features/quality/components/AgentTable.tsx`
- Create: `dashboard/src/features/quality/components/SlaViolationBanner.tsx`

- [ ] **Step 1: Create SlaViolationBanner component**

Create `dashboard/src/features/quality/components/SlaViolationBanner.tsx`:

```tsx
import React from "react";
import type { SlaViolation } from "../../../lib/types.js";
import cStyles from "../../../components/components.module.css";

interface Props { violations: SlaViolation[]; }

export const SlaViolationBanner: React.FC<Props> = ({ violations }) => {
  if (violations.length === 0) return null;
  return (
    <div className={`${cStyles.alertBanner} ${cStyles.alertError}`}>
      <strong>⚠ {violations.length} SLA Violation{violations.length > 1 ? "s" : ""}</strong>
      <span style={{ fontSize: 12, color: "var(--text-dim)" }}>
        {violations.map((v) => `${v.agentName}: ${v.violations[0]}`).join(" | ")}
      </span>
    </div>
  );
};
```

- [ ] **Step 2: Create AgentTable component**

Create `dashboard/src/features/quality/components/AgentTable.tsx`:

```tsx
import React from "react";
import { useNavigate } from "react-router-dom";
import type { AgentScorecard, SlaViolation } from "../../../lib/types.js";
import { DataTable } from "../../../components/DataTable.js";
import { Badge } from "../../../components/Badge.js";

interface Props {
  scorecards: AgentScorecard[];
  violations: SlaViolation[];
}

const trendLabel: Record<string, { text: string; color: string }> = {
  improving: { text: "↑", color: "var(--green)" },
  declining: { text: "↓", color: "var(--red)" },
  stable: { text: "—", color: "var(--text-dim)" },
};

export const AgentTable: React.FC<Props> = ({ scorecards, violations }) => {
  const navigate = useNavigate();
  const violationSet = new Set(violations.map((v) => v.agentName));

  const columns = [
    {
      key: "agentName",
      header: "Agent",
      sortable: true,
      sortValue: (r: AgentScorecard) => r.agentName,
      render: (r: AgentScorecard) => (
        <span style={{ fontWeight: 600 }}>
          {r.agentName}
          {violationSet.has(r.agentName) && <Badge variant="error" > SLA</Badge>}
        </span>
      ),
    },
    { key: "totalTraces", header: "Traces", sortable: true, sortValue: (r: AgentScorecard) => r.totalTraces, render: (r: AgentScorecard) => r.totalTraces.toLocaleString() },
    { key: "successRate", header: "Success", sortable: true, sortValue: (r: AgentScorecard) => r.successRate, render: (r: AgentScorecard) => <span style={{ color: r.successRate >= 95 ? "var(--green)" : "var(--red)" }}>{r.successRate}%</span> },
    { key: "p95LatencyMs", header: "P95 Lat.", sortable: true, sortValue: (r: AgentScorecard) => r.p95LatencyMs, render: (r: AgentScorecard) => `${Math.round(r.p95LatencyMs)}ms` },
    { key: "totalCost", header: "Cost", sortable: true, sortValue: (r: AgentScorecard) => r.totalCost, render: (r: AgentScorecard) => `$${r.totalCost.toFixed(2)}` },
    { key: "qualityTrend", header: "Trend", render: (r: AgentScorecard) => { const t = trendLabel[r.qualityTrend]; return <span style={{ color: t.color }}>{t.text}</span>; } },
  ];

  return (
    <DataTable
      columns={columns}
      data={scorecards}
      keyExtractor={(r) => r.agentName}
      onRowClick={(r) => navigate(`/scorecards?agent=${encodeURIComponent(r.agentName)}`)}
    />
  );
};
```

- [ ] **Step 3: Implement ScorecardsPage**

Rewrite `dashboard/src/features/quality/ScorecardsPage.tsx`:

```tsx
import React, { useState, useEffect } from "react";
import { PageHeader } from "../../components/PageHeader.js";
import { StatCard } from "../../components/StatCard.js";
import { FilterChips } from "../../components/FilterChips.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";
import { SlaViolationBanner } from "./components/SlaViolationBanner.js";
import { AgentTable } from "./components/AgentTable.js";
import { fetchScorecards, fetchSlaViolations } from "./api.js";
import type { AgentScorecard, SlaViolation } from "../../lib/types.js";

const PERIODS = ["7", "30", "90"];

export default function ScorecardsPage() {
  const [period, setPeriod] = useState("30");
  const [scorecards, setScorecards] = useState<AgentScorecard[]>([]);
  const [violations, setViolations] = useState<SlaViolation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    setError("");
    Promise.all([
      fetchScorecards(Number(period)),
      fetchSlaViolations(Number(period)),
    ])
      .then(([sc, viol]) => {
        setScorecards(sc.scorecards);
        setViolations(viol.violations);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [period]);

  if (loading) return <LoadingSpinner />;

  const avgSuccess = scorecards.length > 0
    ? (scorecards.reduce((s, c) => s + c.successRate, 0) / scorecards.length).toFixed(1)
    : "—";
  const totalCost = scorecards.reduce((s, c) => s + c.totalCost, 0);

  return (
    <div>
      <PageHeader
        title="Agent Scorecards"
        description="Performance overview across all agents"
        actions={
          <FilterChips
            options={PERIODS.map((p) => `${p}d`)}
            selected={`${period}d`}
            onSelect={(v) => setPeriod(v.replace("d", ""))}
          />
        }
      />

      {error && <div style={{ color: "var(--red)", marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 12, marginBottom: 16 }}>
        <StatCard label="Agents" value={scorecards.length} color="var(--accent)" />
        <StatCard label="Avg Success" value={`${avgSuccess}%`} color="var(--green)" />
        <StatCard label="SLA Violations" value={violations.length} color={violations.length > 0 ? "var(--red)" : "var(--green)"} />
        <StatCard label={`Cost (${period}d)`} value={`$${totalCost.toFixed(2)}`} color="var(--yellow)" />
      </div>

      <SlaViolationBanner violations={violations} />
      <AgentTable scorecards={scorecards} violations={violations} />
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/features/quality/
git commit -m "feat: scorecards page with SLA violation banner and agent table"
```

---

### Task 13: Regressions page

**Files:**
- Rewrite: `dashboard/src/features/quality/RegressionsPage.tsx`

- [ ] **Step 1: Implement RegressionsPage**

Rewrite `dashboard/src/features/quality/RegressionsPage.tsx`:

```tsx
import React, { useState, useEffect } from "react";
import { PageHeader } from "../../components/PageHeader.js";
import { Badge } from "../../components/Badge.js";
import { LoadingSpinner } from "../../components/LoadingSpinner.js";
import { runRegressionCheck, fetchRegressionHistory, snapshotBaseline } from "./api.js";
import type { RegressionCheckResult } from "../../lib/types.js";
import cStyles from "../../components/components.module.css";

export default function RegressionsPage() {
  const [checkResults, setCheckResults] = useState<RegressionCheckResult[] | null>(null);
  const [history, setHistory] = useState<unknown[]>([]);
  const [historyTotal, setHistoryTotal] = useState(0);
  const [historyOffset, setHistoryOffset] = useState(0);
  const [checking, setChecking] = useState(false);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoadingHistory(true);
    fetchRegressionHistory({ limit: 50, offset: historyOffset })
      .then((data) => { setHistory(data.events); setHistoryTotal(data.total); })
      .catch((err) => setError(err.message))
      .finally(() => setLoadingHistory(false));
  }, [historyOffset]);

  const handleCheck = async () => {
    setChecking(true);
    setError("");
    try {
      const result = await runRegressionCheck();
      setCheckResults(result.agents);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Check failed");
    } finally {
      setChecking(false);
    }
  };

  const handleSnapshot = async (agentName: string) => {
    try {
      await snapshotBaseline(agentName);
      alert(`Baseline snapshot saved for ${agentName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Snapshot failed");
    }
  };

  return (
    <div>
      <PageHeader
        title="Regressions"
        description="Detect behavioral changes in your agents"
        actions={
          <button className={`${cStyles.btn} ${cStyles.btnPrimary}`} onClick={handleCheck} disabled={checking}>
            {checking ? "Analyzing..." : "Run Check"}
          </button>
        }
      />

      {error && <div className={`${cStyles.alertBanner} ${cStyles.alertError}`}>{error}</div>}

      {checkResults && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>Check Results</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            {checkResults.map((agent) => (
              <div key={agent.agentName} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <span style={{ fontWeight: 600 }}>{agent.agentName}</span>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <Badge variant={agent.hasRegression ? "error" : "success"}>
                      {agent.hasRegression ? "Regression" : "Healthy"}
                    </Badge>
                    <button className={cStyles.btn} style={{ fontSize: 11, padding: "4px 8px" }} onClick={() => handleSnapshot(agent.agentName)}>
                      Snapshot
                    </button>
                  </div>
                </div>
                {agent.regressions.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: "var(--red)", marginTop: 4 }}>
                    {r.metric}: {r.baselineValue.toFixed(2)} → {r.currentValue.toFixed(2)} ({r.changePercent > 0 ? "+" : ""}{r.changePercent.toFixed(1)}%)
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>History</h3>
      {loadingHistory ? <LoadingSpinner /> : (
        <>
          <table className={cStyles.table}>
            <thead>
              <tr>
                <th>Detected</th><th>Agent</th><th>Metric</th><th>Baseline</th><th>Current</th><th>Change</th>
              </tr>
            </thead>
            <tbody>
              {(history as Array<Record<string, unknown>>).map((e, i) => (
                <tr key={i}>
                  <td style={{ fontFamily: "var(--mono)", fontSize: 12 }}>{new Date(e.detected_at as string).toLocaleString()}</td>
                  <td style={{ fontWeight: 600 }}>{e.agent_name as string}</td>
                  <td>{e.metric as string}</td>
                  <td>{(e.baseline_value as number).toFixed(2)}</td>
                  <td>{(e.current_value as number).toFixed(2)}</td>
                  <td style={{ color: (e.change_percent as number) > 0 ? "var(--red)" : "var(--green)" }}>
                    {(e.change_percent as number) > 0 ? "+" : ""}{(e.change_percent as number).toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {historyTotal > 50 && (
            <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
              <button className={cStyles.btn} disabled={historyOffset === 0} onClick={() => setHistoryOffset(Math.max(0, historyOffset - 50))}>Previous</button>
              <span style={{ color: "var(--text-dim)", fontSize: 13, alignSelf: "center" }}>{historyOffset + 1}–{Math.min(historyOffset + 50, historyTotal)} of {historyTotal}</span>
              <button className={cStyles.btn} disabled={historyOffset + 50 >= historyTotal} onClick={() => setHistoryOffset(historyOffset + 50)}>Next</button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/src/features/quality/RegressionsPage.tsx
git commit -m "feat: regressions page with check results and history"
```

---

## Chunk 4: Feature Pages — Traces & Sources

### Task 14: Traces feature API and pages

**Files:**
- Create: `dashboard/src/features/traces/api.ts`
- Rewrite: `dashboard/src/features/traces/TracesPage.tsx`
- Rewrite: `dashboard/src/features/traces/TraceDetailPage.tsx`
- Rewrite: `dashboard/src/features/traces/SourcesPage.tsx`
- Create: `dashboard/src/features/traces/components/SpanTree.tsx`
- Create: `dashboard/src/features/traces/TracesPage.module.css`

This task implements the trace list (split-panel), trace detail, and sources pages. These are React reimplementations of the existing ingest dashboard views.

Due to the size of these files, they follow the same patterns established in the quality feature (API module → page component → sub-components) but port the existing HTML/JS logic from `packages/ingest/src/routes/dashboard.ts` into React components. The key implementation details:

- [ ] **Step 1: Create traces API module**

Create `dashboard/src/features/traces/api.ts`:

```typescript
import { apiFetch } from "../../lib/api.js";
import type { Trace, SourceSummary } from "../../lib/types.js";

export async function fetchTraces(opts?: { limit?: number; offset?: number; agentName?: string; environment?: string; status?: string }) {
  const params = new URLSearchParams();
  if (opts?.limit) params.set("limit", String(opts.limit));
  if (opts?.offset) params.set("offset", String(opts.offset));
  if (opts?.agentName) params.set("agentName", opts.agentName);
  if (opts?.environment) params.set("environment", opts.environment);
  if (opts?.status) params.set("status", opts.status);
  return apiFetch<{ traces: Trace[] }>(`/traces?${params}`);
}

export async function fetchTrace(id: string) {
  return apiFetch<Trace>(`/traces/${id}`);
}

export async function fetchSources() {
  return apiFetch<{ sources: SourceSummary[] }>("/sources");
}
```

- [ ] **Step 2: Implement TracesPage with split-panel layout**

Rewrite `dashboard/src/features/traces/TracesPage.tsx` — split-panel with trace list on left, detail on right. Port the filter chips, stats bar, and trace list rendering from the ingest dashboard. Use `fetchTraces()` with limit=50 and "Load more" button. On trace click, fetch full trace and render detail in right panel.

- [ ] **Step 3: Implement SpanTree component**

Create `dashboard/src/features/traces/components/SpanTree.tsx` — recursive span tree with expandable nodes showing type badge, duration, model name, tool name, expandable input/output content, token counts. Port the rendering logic from the ingest dashboard's `renderSpanNode` function.

- [ ] **Step 4: Implement TraceDetailPage**

Rewrite `dashboard/src/features/traces/TraceDetailPage.tsx` — full-page trace detail with `useParams()` to get trace ID, fetch trace, render stats grid + source info + metadata + SpanTree.

- [ ] **Step 5: Implement SourcesPage**

Rewrite `dashboard/src/features/traces/SourcesPage.tsx` — grid of source cards. Port from ingest dashboard's `renderSources` function.

- [ ] **Step 6: Build and verify**

Run: `cd dashboard && npm run build`
Expected: Clean build

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/features/traces/
git commit -m "feat: traces, trace detail, and sources pages"
```

---

## Chunk 5: Feature Pages — Settings

### Task 15: Settings feature API and pages

**Files:**
- Create: `dashboard/src/features/settings/api.ts`
- Rewrite: `dashboard/src/features/settings/SettingsPage.tsx`
- Rewrite: `dashboard/src/features/settings/TeamPage.tsx`
- Rewrite: `dashboard/src/features/settings/ApiKeysPage.tsx`
- Create: `dashboard/src/features/settings/components/InviteModal.tsx`
- Create: `dashboard/src/features/settings/components/CreateKeyModal.tsx`

- [ ] **Step 1: Create settings API module**

Create `dashboard/src/features/settings/api.ts`:

```typescript
import { apiFetch } from "../../lib/api.js";
import type { TeamMember, ApiKeyRecord, BillingStatus } from "../../lib/types.js";

export async function fetchMyTeams() {
  return apiFetch<{ teams: Array<{ id: string; name: string; memberCount: number; createdAt: string }> }>("/teams/my");
}

export async function fetchTeamMembers(teamId: string) {
  return apiFetch<{ members: TeamMember[] }>(`/teams/${teamId}/members`);
}

export async function inviteTeamMember(teamId: string, email: string) {
  return apiFetch<{ userId: string; email: string; role: string }>(`/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify({ email }),
  });
}

export async function updateMemberRole(teamId: string, userId: string, role: string) {
  return apiFetch<{ userId: string; role: string }>(`/teams/${teamId}/members/${userId}`, {
    method: "PUT",
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(teamId: string, userId: string) {
  return apiFetch<{ removed: boolean }>(`/teams/${teamId}/members/${userId}`, { method: "DELETE" });
}

export async function fetchApiKeys() {
  return apiFetch<{ keys: ApiKeyRecord[] }>("/api-keys");
}

export async function createApiKey(name: string) {
  return apiFetch<{ id: string; key: string; prefix: string; name: string; createdAt: string }>("/api-keys", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function revokeApiKey(id: string) {
  return apiFetch<{ revoked: boolean }>(`/api-keys/${id}`, { method: "DELETE" });
}

export async function fetchBillingStatus() {
  return apiFetch<BillingStatus>("/billing/status");
}

export async function createCheckoutSession() {
  return apiFetch<{ url: string }>("/billing/checkout", { method: "POST" });
}

export async function createPortalSession() {
  return apiFetch<{ url: string }>("/billing/portal", { method: "POST" });
}
```

- [ ] **Step 2: Implement SettingsPage**

Rewrite `dashboard/src/features/settings/SettingsPage.tsx` — single scrollable page with Profile, Plan & Billing, Notifications (disabled), and Account sections. Use `fetchBillingStatus()` for plan/usage display. "Manage Subscription" opens Stripe portal URL in new tab.

- [ ] **Step 3: Implement TeamPage**

Rewrite `dashboard/src/features/settings/TeamPage.tsx` — fetch teams via `fetchMyTeams()`, select first team, fetch members via `fetchTeamMembers()`. Members table with role badges, role change dropdown (owner-only), remove button. "Invite Member" button opens InviteModal.

- [ ] **Step 4: Create InviteModal**

Create `dashboard/src/features/settings/components/InviteModal.tsx` — modal with email input, calls `inviteTeamMember()`, closes on success with member list refresh.

- [ ] **Step 5: Implement ApiKeysPage**

Rewrite `dashboard/src/features/settings/ApiKeysPage.tsx` — fetch keys via `fetchApiKeys()`. Keys table with prefix, name, dates, status badge, revoke button. "Create API Key" opens CreateKeyModal.

- [ ] **Step 6: Create CreateKeyModal**

Create `dashboard/src/features/settings/components/CreateKeyModal.tsx` — modal with name input, calls `createApiKey()`, shows the full key with copy button and "only shown once" warning. "Done" button dismisses.

- [ ] **Step 7: Build and verify**

Run: `cd dashboard && npm run build`
Expected: Clean build

- [ ] **Step 8: Commit**

```bash
git add dashboard/src/features/settings/
git commit -m "feat: settings, team members, and API keys pages"
```

---

## Chunk 6: Build, Deploy, Final Verification

### Task 16: Build verification and .gitignore

- [ ] **Step 1: Add .superpowers/ to .gitignore**

Add to the enterprise repo's `.gitignore`:
```
.superpowers/
dashboard/node_modules/
dashboard/dist/
```

- [ ] **Step 2: Full build**

Run: `cd dashboard && npm run build`
Expected: Clean build, `dashboard/dist/` contains `index.html` and JS/CSS assets

- [ ] **Step 3: Typecheck**

Run: `cd dashboard && npm run typecheck`
Expected: No type errors

- [ ] **Step 4: Commit**

```bash
git add .gitignore dashboard/
git commit -m "feat: enterprise dashboard Phase 2 complete"
```

---

### Task 17: Deploy to Cloudflare Pages

- [ ] **Step 1: Push to remote**

```bash
git push origin main
```

- [ ] **Step 2: Configure Cloudflare Pages**

In the Cloudflare dashboard (or via Wrangler CLI):
- Connect `seanfraserio/lantern-enterprise` repo
- Build command: `cd dashboard && npm install && npm run build`
- Build output directory: `dashboard/dist`
- Environment variable: `VITE_API_URL` = `https://lantern-api-100029703606.us-central1.run.app`

- [ ] **Step 3: Verify deployment**

Visit `https://openlanternai-dashboard.pages.dev`
Expected: Login page renders. After login, sidebar navigation works, all pages load.

- [ ] **Step 4: Redeploy API server with updated CSP**

```bash
cd /Users/sfraser/DevOps/Projects/lantern
docker build --platform linux/amd64 -f docker/Dockerfile.api -t us-central1-docker.pkg.dev/lanternai-490223/lantern/api:phase2 .
docker push us-central1-docker.pkg.dev/lanternai-490223/lantern/api:phase2
gcloud run deploy lantern-api --image us-central1-docker.pkg.dev/lanternai-490223/lantern/api:phase2 --region us-central1
```

- [ ] **Step 5: Smoke test**

1. Login at dashboard URL → should redirect to `/traces`
2. Navigate to Scorecards → should show agent table
3. Navigate to Regressions → "Run Check" should return results
4. Navigate to Settings → should show billing status
5. Navigate to Team Members → should show member list
6. Navigate to API Keys → should show key list
