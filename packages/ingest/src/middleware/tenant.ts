import { createHash } from "node:crypto";
import type pg from "pg";

interface TenantInfo {
  tenantId: string;
  tenantSlug: string;
  resolvedAt: number;
}

/**
 * Resolves API keys to tenant info with an in-memory LRU cache.
 * Used by the ingest server in multi-tenant (managed cloud) mode.
 */
export class TenantResolver {
  private cache: Map<string, TenantInfo> = new Map();
  private cacheTtlMs: number;
  private maxCacheSize: number;

  constructor(private pool: pg.Pool, opts?: { cacheTtlMs?: number; maxCacheSize?: number }) {
    this.cacheTtlMs = opts?.cacheTtlMs ?? 300_000; // 5 minutes
    this.maxCacheSize = opts?.maxCacheSize ?? 1000;
  }

  async resolve(apiKey: string): Promise<TenantInfo | null> {
    const keyHash = createHash("sha256").update(apiKey).digest("hex");

    // Check cache
    const cached = this.cache.get(keyHash);
    if (cached && Date.now() - cached.resolvedAt < this.cacheTtlMs) {
      return cached;
    }

    // Query database
    const { rows } = await this.pool.query(
      `SELECT ak.tenant_id, t.slug
       FROM public.api_keys ak
       JOIN public.tenants t ON ak.tenant_id = t.id
       WHERE ak.key_hash = $1 AND ak.revoked_at IS NULL`,
      [keyHash]
    );

    if (rows.length === 0) return null;

    const info: TenantInfo = {
      tenantId: rows[0].tenant_id as string,
      tenantSlug: rows[0].slug as string,
      resolvedAt: Date.now(),
    };

    // Evict oldest if cache is full
    if (this.cache.size >= this.maxCacheSize) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(keyHash, info);

    // Update last_used_at (fire-and-forget)
    this.pool.query(
      `UPDATE public.api_keys SET last_used_at = now() WHERE key_hash = $1`,
      [keyHash]
    ).catch(() => {});

    return info;
  }
}
