# Enterprise Dashboard — Phase 2 Design Spec

## Overview

Build a React SPA dashboard for the Lantern enterprise product, deployed to Cloudflare Pages at `openlanternai-dashboard.pages.dev`. The dashboard connects to the API server (`lantern-api` on Cloud Run) and exposes platform capabilities that currently exist only as backend APIs.

Phase 2 delivers the SPA shell, authentication, core trace views, quality monitoring (scorecards and regressions), and settings/team management.

## Repository

All dashboard code lives in `lantern-enterprise` (`seanfraserio/lantern-enterprise`), under a new `dashboard/` top-level directory. It is NOT part of the OSS `lantern` repo. The existing ingest dashboard in the OSS repo remains unchanged.

## Tech Stack

- **React 18** with JSX (already a dependency in the monorepo)
- **React Router v6** for client-side routing
- **Vite** for build and dev server
- **CSS Modules** with CSS custom properties matching the existing ingest dashboard dark theme
- **TypeScript** throughout
- **Deployment:** Static build (`vite build`) deployed to Cloudflare Pages

## Architecture

### Directory Structure

```
lantern-enterprise/
├── src/                         # Existing enterprise library
│   ├── alerts/
│   ├── audit/
│   ├── cloud/
│   ├── pii/
│   ├── rbac/
│   └── index.ts
│
├── dashboard/                   # NEW — React SPA
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json
│   ├── package.json             # Separate package for dashboard deps
│   └── src/
│       ├── main.tsx             # Entry point, renders <App />
│       ├── app.tsx              # BrowserRouter + AuthProvider + Layout
│       ├── theme.css            # Global CSS variables (dark theme)
│       │
│       ├── components/          # Shared UI primitives
│       │   ├── Sidebar.tsx
│       │   ├── PageHeader.tsx
│       │   ├── StatCard.tsx
│       │   ├── DataTable.tsx
│       │   ├── Badge.tsx
│       │   ├── Modal.tsx
│       │   ├── EmptyState.tsx
│       │   ├── FilterChips.tsx
│       │   └── LoadingSpinner.tsx
│       │
│       ├── lib/
│       │   ├── api.ts           # Fetch wrapper with JWT auth
│       │   ├── auth.tsx         # AuthContext, useAuth hook
│       │   └── types.ts         # Shared TypeScript types
│       │
│       └── features/
│           ├── auth/
│           │   └── LoginPage.tsx
│           │
│           ├── traces/
│           │   ├── TracesPage.tsx
│           │   ├── TraceDetailPage.tsx
│           │   ├── SourcesPage.tsx
│           │   ├── components/
│           │   │   ├── TraceList.tsx
│           │   │   ├── SpanTree.tsx
│           │   │   └── SourceCard.tsx
│           │   └── api.ts
│           │
│           ├── quality/
│           │   ├── ScorecardsPage.tsx
│           │   ├── RegressionsPage.tsx
│           │   ├── components/
│           │   │   ├── AgentTable.tsx
│           │   │   ├── SlaViolationBanner.tsx
│           │   │   └── RegressionRow.tsx
│           │   └── api.ts
│           │
│           └── settings/
│               ├── SettingsPage.tsx
│               ├── TeamPage.tsx
│               ├── ApiKeysPage.tsx
│               ├── components/
│               │   ├── ProfileSection.tsx
│               │   ├── BillingSection.tsx
│               │   ├── MemberRow.tsx
│               │   ├── InviteModal.tsx
│               │   └── CreateKeyModal.tsx
│               └── api.ts
```

### Authentication

Simple JWT flow using the existing `POST /auth/login` endpoint.

- `AuthContext` holds the JWT token in React state and persists to `sessionStorage`
- On login, the JWT payload is decoded (base64 decode of the middle segment) to extract `sub`, `tenantId`, `tenantSlug`, `role`, and `exp`. The login response also provides `user.email` and `user.role`. Both the raw token and the decoded user info (email, role, tenantSlug) are stored in the auth context for use by the sidebar and permission checks.
- `api.ts` is a thin `fetch` wrapper that attaches `Authorization: Bearer <token>` to every request
- On 401 response, the wrapper clears the token and redirects to `/login`
- **Token refresh:** The backend exposes `POST /token/refresh` (requires a valid JWT). The auth module sets a timer to proactively refresh the token when it is within 1 hour of expiry. If the refresh fails (e.g., user is offline), the user is logged out on next 401. This prevents mid-session logouts for users with the dashboard open for extended periods.
- Protected routes wrapped in a `<RequireAuth>` component that checks for token presence

### Routing

```
/login              → LoginPage (public)
/traces             → TracesPage (protected)
/traces/:id         → TraceDetailPage (protected)
/sources            → SourcesPage (protected)
/scorecards         → ScorecardsPage (protected)
/regressions        → RegressionsPage (protected)
/settings           → SettingsPage (protected)
/settings/team      → TeamPage (protected)
/settings/api-keys  → ApiKeysPage (protected)
```

Default redirect: unauthenticated → `/login`, authenticated → `/traces`.

Catch-all: any undefined route (`*`) redirects to `/traces` for authenticated users or `/login` for unauthenticated users.

### Layout

Fixed sidebar navigation with section headers:

```
OBSERVE
  Traces
  Sources

QUALITY
  Scorecards
  Regressions

────────────── (separator)
  Team Members
  API Keys
  Settings
```

Additional sidebar sections (Costs, Security, Alerts) will be added in later phases as empty placeholders with "Coming soon" badges.

The sidebar shows the Lantern logo at top, the tenant slug below, and the current user email + logout button at bottom.

## Page Designs

### Login Page

Full-screen centered card with:
- Lantern logo
- Email and password inputs
- "Sign In" button
- Error message display for invalid credentials or rate limiting
- No registration — users are created via API or admin tooling

### Traces Page

Split-panel layout (matching the existing ingest dashboard):

**Left panel (420px):**
- Stats bar: total traces, success count, error count, avg latency
- Filter chips: by environment, status, source service
- Scrollable trace list with: agent name, status badge, environment, duration, span count, cost, timestamp

**Right panel:**
- Empty state when no trace selected
- On trace select: full detail view with stats cards, source info, metadata, span tree

**Pagination:** The trace list uses limit/offset pagination. Default limit of 50, with "Load more" button at the bottom. The `GET /traces` endpoint already supports `limit` and `offset` query parameters.

Calls: `GET /traces`, `GET /traces/:id`, `GET /sources` (for filter options).

**Note on API paths:** The API server registers trace routes at `/traces` (no `/v1/` prefix). The `/v1/traces` path is used by the ingest server for SDK trace ingestion. The enterprise dashboard calls the API server routes directly without the `/v1/` prefix.

### Trace Detail Page (`/traces/:id`)

Full-page alternative to the split panel (linked from trace list or direct URL):
- Page header with agent name, status badge, trace ID
- Stats grid: environment, duration, input tokens, output tokens, cost, start time
- Source info bar (service name, SDK version, exporter type, session ID)
- Metadata display (collapsible JSON block)
- Span tree: hierarchical visualization with type badges (llm_call, tool_call, retrieval, reasoning_step), timing, expandable input/output content, token counts per span

### Sources Page

Grid of source cards showing:
- Service name, exporter type badge
- Trace count, last seen timestamp
- SDK version
- Environments in use (badge chips)
- Connected agents list

SDK quickstart code snippet section at bottom.

Calls: `GET /sources`.

### Scorecards Page

Table-first layout with SLA violation banner.

**Top controls:** Period selector (7d / 30d / 90d), environment filter dropdown.

**Summary stats row:** Agent count, average success rate, SLA violation count, total cost for the selected period (labeled as "Cost (30d)" etc., not "monthly").

**SLA violation banner:** Amber/red alert bar showing which agents are breaching SLA targets with specific metric details. Only shown when violations exist. Clicking an agent name scrolls to its row in the table.

**Agent table (sortable columns):**
- Agent name
- Total traces
- Success rate (green/red coloring based on SLA target)
- P95 latency (green/red coloring based on SLA target)
- Avg cost per trace
- Total cost
- Quality trend (improving ↑ / stable — / declining ↓)

Clicking an agent row navigates to a detail view showing the daily breakdown chart and SLA target configuration for that agent (uses `GET /scorecards/:agentName`).

**SLA configuration:** "Set SLA" button per agent opens a modal to configure targets (min success rate, max P95 latency, max cost per trace) via `POST /scorecards/sla`. The modal pre-populates existing targets from the new `GET /scorecards/sla` endpoint (see Backend Changes).

Calls: `GET /scorecards`, `GET /scorecards/sla` (new), `GET /scorecards/sla/violations`, `GET /scorecards/:agentName`, `POST /scorecards/sla`.

### Regressions Page

**Top section:** "Run Check" button triggers `GET /regressions/check`. Shows a loading state during analysis, then displays results inline:
- Per-agent card showing: baseline metrics vs current metrics
- Flagged regressions highlighted in red with metric name, baseline → current, % change
- Agents with no regressions shown as "Healthy" with green badge

**History section:** Paginated table from `GET /regressions/history`:
- Columns: timestamp, agent name, metric, baseline value, current value, % change
- Filter by agent name dropdown
- Pagination controls (limit/offset)

**Baseline snapshot:** "Snapshot Baseline" button per agent triggers `POST /regressions/baseline/:agentName` to manually capture a baseline for comparison. Useful after deploying prompt changes or model upgrades.

Calls: `GET /regressions/check`, `GET /regressions/history`, `POST /regressions/baseline/:agentName`.

### Settings Page (`/settings`)

Single scrollable page with card sections (Tutelr/Tryggy pattern):

**Profile section:**
- User email (read-only, from JWT)
- Display name text input
- "Save Changes" button
- Note: display name is not currently stored in the backend users table. Phase 2 renders the UI but the save button is disabled with "Coming soon" until we add a `display_name` column.

**Plan & Billing section:**
- Current plan badge (Free / Team / Enterprise)
- Usage bar: traces used this month vs plan limit with percentage
- "Manage Subscription" button → calls `POST /billing/portal` and opens the returned Stripe URL in a new tab
- If no Stripe customer exists, show "Subscribe" button → calls `POST /billing/checkout`

**Notifications section:**
- Toggle switches for notification types
- All toggles disabled with "Coming soon" label (backend not implemented yet)

**Account section:**
- "Member since" date
- "Log out" button

Calls: `GET /billing/status`, `POST /billing/portal`, `POST /billing/checkout`.

### Team Members Page (`/settings/team`)

**Header:** Team name, member count, creation date, "Invite Member" button.

**Invite modal:** Email input, role dropdown (admin/member), "Send Invite" button. Calls `POST /teams/:id/members` (new endpoint).

**Members table:**
- Columns: name/email, role badge (Owner/Admin/Member), joined date, actions
- Role dropdown: owners and admins can change other members' roles (not their own)
- Remove button with confirmation modal
- Owner role cannot be changed or removed

Calls: `GET /teams/:id` (existing), plus new endpoints (see Backend Changes below).

### API Keys Page (`/settings/api-keys`)

**Header:** "Create API Key" button.

**Create modal:** Name input, "Create" button. On success, shows the full key with a copy-to-clipboard button and a warning: "This key will only be shown once. Copy it now." Modal cannot be dismissed until user clicks "Done".

**Keys table:**
- Columns: prefix (`lnt_xxxx...`), name, created date, last used date, status badge (Active/Revoked)
- "Revoke" button per active key with confirmation
- Revoked keys shown greyed out

Calls: `GET /api-keys`, `POST /api-keys`, `DELETE /api-keys/:id` (soft revoke — sets `revoked_at`, does not delete the record). All existing endpoints.

## Backend Changes

### Roles: Per-Tenant, Not Per-Team

Roles (owner/admin/member) are stored on `public.users.role` and are tenant-scoped, not team-scoped. A user's role applies across the entire tenant. Teams control agent visibility (which agents a member can see), not permission levels. The Team Members page displays the user's tenant-level role and allows owners/admins to change it.

### New Endpoints

#### In `packages/api/src/routes/teams.ts`:

**`GET /teams/my`** — Get the current user's teams within their tenant.
- Resolution: (1) get user email from `public.users` using `JWT.sub`, (2) find team memberships from `team_members` where `user_email` matches, (3) filter teams by `tenant_id` matching `JWT.tenantId`
- If the user has no team memberships, returns all teams for the tenant (owners/admins see everything)
- Returns: `{ teams: [{ id, name, memberCount, createdAt }] }`

**`GET /teams/:id/members`** — Get detailed member list for a team.
- JOINs `team_members.user_email` with `public.users` to get role, display name, and creation date per member
- Auth: user must be in the team, or be an owner/admin of the tenant
- Returns: `{ members: [{ userId, email, displayName, role, joinedAt }] }`

**`POST /teams/:id/members`** — Invite a member to a team.
- Body: `{ email: string }`
- Auth: requires owner or admin role (tenant-level)
- If a user with that email exists in the tenant: adds them to the team via `team_members`
- If no user exists: creates a `public.users` record with a random password and sends an invite email with a password reset link (see `/auth/reset-password` below)
- Returns the new member record

**`PUT /teams/:id/members/:userId`** — Update a member's tenant-level role.
- Body: `{ role: "admin" | "member" }`
- Auth: requires owner role (only owners can change roles)
- Updates `public.users.role` for the target user
- Cannot change the owner's role
- Returns updated member record

**`DELETE /teams/:id/members/:userId`** — Remove a member from a team.
- Auth: requires owner or admin role
- Removes the `team_members` row (does not delete the user account)
- Cannot remove the tenant owner
- Returns `{ removed: true }`

#### In `packages/api/src/routes/auth.ts`:

**`POST /auth/forgot-password`** — Request a password reset.
- Body: `{ email: string }`
- Generates a time-limited reset token (stored as SHA256 hash in a new `password_reset_tokens` table, expires in 1 hour)
- Sends an email with a reset link to `${APP_URL}/reset-password?token=<token>`
- Always returns 200 regardless of whether the email exists (prevents enumeration)

**`POST /auth/reset-password`** — Reset password with token.
- Body: `{ token: string, password: string }`
- Validates the token against the hashed version in the database, checks expiry
- Applies the same password validation rules (min 8 chars, uppercase, lowercase, digit)
- Updates the user's password hash and deletes the token
- Returns `{ success: true }`

#### In `packages/api/src/routes/scorecards.ts`:

**`GET /scorecards/sla`** — List all SLA targets for the tenant.
- Returns: `{ targets: [{ id, agentName, minSuccessRate, maxP95LatencyMs, maxCostPerTrace, createdAt }] }`
- Used by the SLA configuration modal to pre-populate existing targets

### Schema Changes

Add to `public.users` table:
- `display_name TEXT` column (nullable, for profile editing)

Add new `public.password_reset_tokens` table:
```sql
CREATE TABLE IF NOT EXISTS public.password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.users(id),
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### API Server CSP Update

The API server's `Content-Security-Policy` header includes `connect-src 'self'`. CSP headers on JSON API responses are not enforced by browsers (CSP only applies to document responses), so this does not block cross-origin fetch from the dashboard SPA. However, for correctness, update the CSP to only be set on HTML responses, or remove `connect-src` from the API server entirely since it serves JSON, not documents.

## Styling

The dashboard uses the same CSS custom properties as the existing ingest dashboard for visual consistency:

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
}
```

CSS modules per component. No CSS framework — plain CSS matching the existing dark theme aesthetic.

## Deployment

- `vite build` produces a static `dist/` directory
- Deployed to Cloudflare Pages connected to the `lantern-enterprise` repo
- Build command: `cd dashboard && npm run build`
- Output directory: `dashboard/dist`
- Environment variable: `VITE_API_URL` pointing to the API server (`https://lantern-api-100029703606.us-central1.run.app`)
- SPA fallback: `dashboard/public/_redirects` file containing `/* /index.html 200` so all routes serve the SPA

## Error Handling

- API errors show inline error banners (not modals) with the error message
- Network failures show a "Connection lost" banner at the top of the page
- Loading states use skeleton loaders for tables and spinner for actions
- Empty states show a descriptive message with suggested action (e.g., "No traces yet. Instrument an agent to start.")

## Testing

- Component tests with Vitest + React Testing Library for interactive components (modals, forms)
- API module tests with mocked fetch
- No E2E tests in Phase 2

## Future Phases (out of scope for Phase 2)

The following sidebar sections will show "Coming soon" badges in Phase 2:

- **Phase 3:** Alerts (Alert History, Channels) — requires alert configuration API routes
- **Phase 4:** Costs (Breakdown, Forecast, Budgets)
- **Phase 5:** Security (PII Scanner, Compliance)
- **Phase 6:** SSO/SAML, Custom Retention
