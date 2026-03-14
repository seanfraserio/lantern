import type pg from "pg";

const TENANT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS traces (
    id UUID PRIMARY KEY,
    session_id UUID NOT NULL,
    agent_name TEXT NOT NULL,
    agent_version TEXT,
    environment TEXT NOT NULL,
    start_time BIGINT NOT NULL,
    end_time BIGINT,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    total_input_tokens INTEGER NOT NULL DEFAULT 0,
    total_output_tokens INTEGER NOT NULL DEFAULT 0,
    estimated_cost_usd REAL NOT NULL DEFAULT 0,
    metadata JSONB NOT NULL DEFAULT '{}',
    source JSONB,
    spans JSONB NOT NULL DEFAULT '[]',
    scores JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS idx_traces_agent ON traces(agent_name);
  CREATE INDEX IF NOT EXISTS idx_traces_env ON traces(environment);
  CREATE INDEX IF NOT EXISTS idx_traces_status ON traces(status);
  CREATE INDEX IF NOT EXISTS idx_traces_start ON traces(start_time DESC);
`;

const SLUG_RE = /^[a-z0-9-]{3,32}$/;

export class SchemaManager {
  constructor(private pool: pg.Pool) {}

  validateSlug(slug: string): boolean {
    return SLUG_RE.test(slug);
  }

  async createTenantSchema(slug: string): Promise<void> {
    if (!this.validateSlug(slug)) {
      throw new Error(`Invalid tenant slug: ${slug}`);
    }
    const schemaName = `tenant_${slug}`;
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`);
    await this.pool.query(`SET search_path TO "${schemaName}"`);
    await this.pool.query(TENANT_SCHEMA_SQL);
    await this.pool.query(`SET search_path TO public`);

    await this.pool.query(
      `INSERT INTO public.schema_versions (id, tenant_id, version)
       SELECT gen_random_uuid(), t.id, 1
       FROM public.tenants t WHERE t.slug = $1
       ON CONFLICT (tenant_id, version) DO NOTHING`,
      [slug]
    );
  }

  async dropTenantSchema(slug: string): Promise<void> {
    if (!this.validateSlug(slug)) {
      throw new Error(`Invalid tenant slug: ${slug}`);
    }
    await this.pool.query(`DROP SCHEMA IF EXISTS "tenant_${slug}" CASCADE`);
  }
}
