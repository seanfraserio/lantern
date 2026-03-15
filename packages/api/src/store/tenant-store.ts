import type pg from "pg";

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  plan: string;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  createdAt: string;
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  role: string;
  createdAt: string;
}

export interface ApiKeyRecord {
  id: string;
  tenantId: string;
  keyPrefix: string;
  name: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export class TenantStore {
  constructor(private pool: pg.Pool) {}

  async initialize(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS public.tenants (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        slug TEXT UNIQUE NOT NULL,
        plan TEXT NOT NULL DEFAULT 'team',
        stripe_customer_id TEXT,
        stripe_subscription_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.users (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.api_keys (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        key_hash TEXT NOT NULL,
        key_prefix TEXT NOT NULL,
        name TEXT NOT NULL,
        last_used_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS public.usage (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        month TEXT NOT NULL,
        trace_count BIGINT NOT NULL DEFAULT 0,
        input_tokens BIGINT NOT NULL DEFAULT 0,
        output_tokens BIGINT NOT NULL DEFAULT 0,
        UNIQUE(tenant_id, month)
      );
      CREATE TABLE IF NOT EXISTS public.schema_versions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tenant_id UUID NOT NULL REFERENCES public.tenants(id),
        version INTEGER NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE(tenant_id, version)
      );
    `);
  }

  async createTenant(name: string, slug: string, plan?: string): Promise<Tenant> {
    const { rows } = await this.pool.query(
      `INSERT INTO public.tenants (name, slug, plan) VALUES ($1, $2, $3) RETURNING *`,
      [name, slug, plan ?? "team"]
    );
    return this.rowToTenant(rows[0]);
  }

  async getTenantBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.tenants WHERE slug = $1`, [slug]
    );
    return rows.length > 0 ? this.rowToTenant(rows[0]) : null;
  }

  async getTenantById(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.tenants WHERE id = $1`, [id]
    );
    return rows.length > 0 ? this.rowToTenant(rows[0]) : null;
  }

  async createUser(tenantId: string, email: string, passwordHash: string, role?: string): Promise<User> {
    const { rows } = await this.pool.query(
      `INSERT INTO public.users (tenant_id, email, password_hash, role) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, email, passwordHash, role ?? "owner"]
    );
    return this.rowToUser(rows[0]);
  }

  async getUserByEmail(email: string): Promise<(User & { passwordHash: string }) | null> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.users WHERE email = $1`, [email]
    );
    if (rows.length === 0) return null;
    return { ...this.rowToUser(rows[0]), passwordHash: rows[0].password_hash as string };
  }

  async storeApiKey(tenantId: string, keyHash: string, keyPrefix: string, name: string): Promise<ApiKeyRecord> {
    const { rows } = await this.pool.query(
      `INSERT INTO public.api_keys (tenant_id, key_hash, key_prefix, name) VALUES ($1, $2, $3, $4) RETURNING *`,
      [tenantId, keyHash, keyPrefix, name]
    );
    return this.rowToApiKey(rows[0]);
  }

  async resolveApiKey(keyHash: string): Promise<{ tenantId: string; tenantSlug: string } | null> {
    const { rows } = await this.pool.query(
      `SELECT ak.tenant_id, t.slug
       FROM public.api_keys ak
       JOIN public.tenants t ON ak.tenant_id = t.id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
      [keyHash]
    );
    if (rows.length === 0) return null;
    this.pool.query(
      `UPDATE public.api_keys SET last_used_at = now() WHERE key_hash = $1`, [keyHash]
    ).catch(() => {});
    return { tenantId: rows[0].tenant_id as string, tenantSlug: rows[0].slug as string };
  }

  async revokeApiKey(keyId: string, tenantId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `UPDATE public.api_keys SET revoked_at = now() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
      [keyId, tenantId]
    );
    return (rowCount ?? 0) > 0;
  }

  async listApiKeys(tenantId: string): Promise<ApiKeyRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT * FROM public.api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`, [tenantId]
    );
    return rows.map((r) => this.rowToApiKey(r));
  }

  private rowToTenant(row: Record<string, unknown>): Tenant {
    return {
      id: row.id as string,
      name: row.name as string,
      slug: row.slug as string,
      plan: row.plan as string,
      stripeCustomerId: (row.stripe_customer_id as string) ?? null,
      stripeSubscriptionId: (row.stripe_subscription_id as string) ?? null,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private rowToUser(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      email: row.email as string,
      role: row.role as string,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }

  private rowToApiKey(row: Record<string, unknown>): ApiKeyRecord {
    return {
      id: row.id as string,
      tenantId: row.tenant_id as string,
      keyPrefix: row.key_prefix as string,
      name: row.name as string,
      lastUsedAt: row.last_used_at ? (row.last_used_at as Date).toISOString() : null,
      revokedAt: row.revoked_at ? (row.revoked_at as Date).toISOString() : null,
      createdAt: (row.created_at as Date).toISOString(),
    };
  }
}
