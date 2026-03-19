# Lantern Dashboard Rebuild — Design Spec

## Goal

Replace the Lantern enterprise dashboard (Vite + React + CSS Modules + custom components) with a Next.js 15 app that matches the Bastion dashboard's architecture and visual quality, while keeping Lantern's indigo brand identity and its own feature set.

## Motivation

The current Lantern dashboard uses a fully custom component library with CSS Modules, Unicode icons, and hand-built primitives. The Bastion dashboard uses Next.js + shadcn/ui + Tailwind — a more polished, maintainable stack. Aligning both dashboards reduces maintenance burden, creates visual consistency across the trilogy, and gives Lantern proper charts, accessible primitives, and a modern deployment pipeline.

---

## Architecture

**Stack:**
- Next.js 15 (App Router, React 19)
- Tailwind CSS 3.4 with indigo brand palette
- shadcn/ui (9 Radix primitives: Button, Card, Dialog, DropdownMenu, Input, Select, Table, Tabs, Badge)
- Lucide React (icons, replacing Unicode symbols)
- Recharts (cost charts, trace timelines — currently absent)
- next-themes (dark mode default)
- NextAuth v5 (Google + GitHub OAuth)
- Cloudflare Pages via `@cloudflare/next-on-pages`

**Copied from Bastion verbatim:**
- All 9 `components/ui/` shadcn primitives
- `lib/utils.ts` (`cn()` helper)
- Layout: `app-shell.tsx`, `theme-provider.tsx`, `theme-toggle.tsx`, `session-provider.tsx`
- `tailwind.config.ts` structure (brand colors swapped to indigo)
- `globals.css` HSL variable system
- `next.config.js` with `NEXT_PUBLIC_APP_VERSION` injection
- `middleware.ts` auth guard

**Ported from current Lantern (business logic, new UI):**
- All 11 feature API modules (function signatures unchanged)
- `lib/types.ts` type definitions
- SpanTree trace visualization (rebuilt with Tailwind)
- Feature page logic (filtering, pagination, sorting)

**Deleted:**
- All 9 CSS Modules
- `theme.css` + custom ThemeProvider
- Custom Modal, Badge, Button, DataTable implementations
- `react-router-dom`, `vite` dependencies
- `main.tsx` Vite entry point

---

## Layout & Navigation

**Sidebar:** 256px fixed, indigo brand, Lucide icons, grouped with uppercase section headers.

```
[Lantern logo — indigo-to-cyan gradient]

── Observe ──
  Traces          (Activity)
  Sources         (Radio)

── Quality ──
  Scorecards      (ClipboardCheck)
  Regressions     (TrendingDown)

── Costs ──
  Breakdown       (PieChart)
  Forecast        (LineChart)

── Security ──
  PII Scanner     (ScanEye)
  Compliance      (ShieldCheck)

── Alerts ──
  History         (Bell)
  Channels        (Send)

─── separator ───
  Team            (Users)
  API Keys        (Key)
  Settings        (Settings)
  Docs            (BookOpen)
  Support         (LifeBuoy)

─── footer ───
  Lantern v{NEXT_PUBLIC_APP_VERSION}
```

**Topbar:** 64px sticky, global. User dropdown, theme toggle (Sun/Moon).

**Active state:** `bg-lantern-indigo/15 text-lantern-indigo-light`

**Section headers:** `text-xs font-semibold tracking-wide text-muted-foreground uppercase` — unique to Lantern (Bastion has fewer nav items and doesn't need grouping).

---

## Pages & Routes

```
app/
├── page.tsx                      → /               Overview (NEW)
├── layout.tsx                    → Root layout
├── login/page.tsx                → /login
├── api/auth/[...nextauth]/route.ts
├── traces/page.tsx               → /traces
├── traces/[id]/page.tsx          → /traces/:id
├── sources/page.tsx              → /sources
├── scorecards/page.tsx           → /scorecards
├── regressions/page.tsx          → /regressions
├── costs/page.tsx                → /costs
├── costs/forecast/page.tsx       → /costs/forecast
├── security/pii/page.tsx         → /security/pii
├── security/compliance/page.tsx  → /security/compliance
├── alerts/page.tsx               → /alerts
├── alerts/channels/page.tsx      → /alerts/channels
├── keys/page.tsx                 → /keys
├── settings/page.tsx             → /settings
├── settings/team/page.tsx        → /settings/team
├── docs/page.tsx                 → /docs
└── support/page.tsx              → /support
```

**20 routes total.** New overview page with 4 stat cards (total traces, total cost, active agents, avg latency), Recharts cost chart, and recent traces list.

Trace detail gets its own route (`/traces/[id]`) instead of the current split-pane layout.

---

## Components

### From Bastion (copy, no changes)

9 shadcn/ui primitives, layout components, `cn()` utility.

### Ported from Lantern (new UI, same logic)

| Component | Current | New |
|-----------|---------|-----|
| StatCard | CSS, value+label | shadcn Card + Lucide icon + trend |
| DataTable | Generic `DataTable<T>` | shadcn Table + inline sort headers |
| Badge | 5 CSS variants | shadcn Badge + CVA (success/error/warning/info/neutral) |
| Modal | Custom overlay | Radix Dialog (shadcn) |
| FilterChips | CSS pills | Tailwind pills with active state |
| PageHeader | Custom | Tailwind div (title/description/actions) |
| LoadingSpinner | Custom CSS | Lucide Loader2 + animate-spin |
| EmptyState | Custom | Tailwind card with icon + message |
| ErrorBoundary | React boundary | Keep as-is |

### Lantern-unique (rebuild with Tailwind)

| Component | Purpose |
|-----------|---------|
| SpanTree | Recursive trace tree, colored by span type (llm=indigo, tool=teal, chain=amber) |
| SpanDetail | Span metadata card, JSON viewer for input/output |
| ReasoningChain | Vertical timeline with step cards |
| CostBreakdown | Recharts BarChart in Card (NEW — no charts today) |
| QualityChart | Recharts LineChart in Card (NEW) |
| AgentTable | shadcn Table with sortable columns |
| SlaViolationBanner | Tailwind alert banner, destructive colors |

### New components

- `UsageChart` — Recharts time series (from Bastion, adapted for cost/trace data)
- `RecentTraces` — Overview page latest traces list

---

## Auth, API Client & Data Fetching

**Auth:** NextAuth v5 with Google + GitHub OAuth. JWT session with `tenantId` and `apiToken`. Login page with indigo-branded OAuth buttons. Middleware redirects unauthenticated users to `/login`.

**API Client:** Port `apiFetch<T>()`, swap auth source from custom context to NextAuth session:

```
Current:  useAuth() → token → apiFetch(path, { token })
New:      useSession() → session.user.apiToken → apiFetch(path, { token })
```

All 11 feature API modules keep their function signatures. Only the auth header injection changes.

**Data fetching:** Client-side `useEffect` + `useState` in page components. No Server Components for data (API requires user token).

---

## Theming & Brand

| Token | Value |
|-------|-------|
| Brand primary | `#4f46e5` (indigo) |
| Brand light | `#6366f1` |
| Brand gradient | indigo → cyan (`#4f46e5` → `#06b6d4`) |
| Active nav bg | `bg-lantern-indigo/15` |
| Primary button | Indigo gradient |
| Default theme | Dark |
| Font | Inter, 14px base |
| Menu font | 15px |
| Mono font | JetBrains Mono (for trace IDs, JSON) |

**Tailwind custom colors:**
```
lantern: {
  indigo: "#4f46e5",
  "indigo-light": "#6366f1",
  cyan: "#06b6d4",
  "cyan-light": "#22d3ee",
}
```

---

## Testing

- Vitest for unit tests
- Test each feature API module (mock apiFetch, verify params/responses)
- Test SpanTree with mock trace data
- Test auth middleware redirect
- Version test (createRequire pattern)

---

## OSS Dashboard Library

Deprecate `packages/dashboard/` as a UI library. Replace contents with type-only re-exports (Trace, Span, etc.). The enterprise dashboard becomes the single source of truth for UI.

---

## Scope

- ~30 files to create (Next.js pages, shadcn components, config)
- ~40 files to delete (CSS Modules, custom components, Vite config)
- ~15 files to port (feature API modules, types, business logic)
- 4-5 phases of implementation
