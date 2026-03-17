import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

// ── Types ──

export interface Prompt {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface PromptSummary extends Prompt {
  activeVersion: number | null;
  variableCount: number;
}

export interface PromptVersion {
  id: string;
  promptId: string;
  version: number;
  content: string;
  model: string | null;
  variables: string[];
  isActive: boolean;
  createdBy: string;
  createdAt: string;
}

// ── Helpers ──

/**
 * Extract `{{variable}}` placeholders from a prompt template.
 * Returns a deduplicated list of variable names.
 */
export function extractVariables(content: string): string[] {
  const matches = content.matchAll(/\{\{(\w+)\}\}/g);
  return [...new Set(Array.from(matches, (m) => m[1]))];
}

// ── Store ──

/**
 * SQLite-backed prompt store for managing prompt templates and versions.
 */
export class PromptStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** Create the prompts and prompt_versions tables if they don't exist. */
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS prompt_versions (
        id TEXT PRIMARY KEY,
        prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        content TEXT NOT NULL,
        model TEXT,
        variables TEXT NOT NULL DEFAULT '[]',
        is_active INTEGER NOT NULL DEFAULT 0,
        created_by TEXT NOT NULL DEFAULT 'system',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(prompt_id, version)
      );

      CREATE INDEX IF NOT EXISTS idx_prompt_versions_prompt ON prompt_versions(prompt_id);
      CREATE INDEX IF NOT EXISTS idx_prompt_versions_active ON prompt_versions(prompt_id, is_active);
    `);
  }

  /** Create a new prompt. Throws if a prompt with the same name already exists. */
  async createPrompt(name: string, description?: string): Promise<Prompt> {
    const id = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO prompts (id, name, description, created_at, updated_at)
           VALUES (@id, @name, @description, @createdAt, @updatedAt)`
        )
        .run({
          id,
          name,
          description: description ?? "",
          createdAt: now,
          updatedAt: now,
        });
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
        const e = new Error(`Prompt with name "${name}" already exists`);
        (e as Error & { code: string }).code = "DUPLICATE";
        throw e;
      }
      throw err;
    }

    return { id, name, description: description ?? "", createdAt: now, updatedAt: now };
  }

  /** List all prompts with their active version number and variable count. */
  async listPrompts(): Promise<PromptSummary[]> {
    const rows = this.db
      .prepare(
        `SELECT
           p.id, p.name, p.description, p.created_at, p.updated_at,
           v.version AS active_version,
           v.variables AS active_variables
         FROM prompts p
         LEFT JOIN prompt_versions v ON v.prompt_id = p.id AND v.is_active = 1
         ORDER BY p.updated_at DESC`
      )
      .all() as Record<string, unknown>[];

    return rows.map((row) => {
      const variables = safeJsonParse<string[]>(row.active_variables as string | null, []);
      return {
        id: row.id as string,
        name: row.name as string,
        description: row.description as string,
        createdAt: row.created_at as string,
        updatedAt: row.updated_at as string,
        activeVersion: (row.active_version as number) ?? null,
        variableCount: variables.length,
      };
    });
  }

  /** Get the currently active version for a prompt, or null if none is active. */
  async getActiveVersion(name: string): Promise<PromptVersion | null> {
    const row = this.db
      .prepare(
        `SELECT v.*
         FROM prompt_versions v
         JOIN prompts p ON p.id = v.prompt_id
         WHERE p.name = @name AND v.is_active = 1`
      )
      .get({ name }) as Record<string, unknown> | undefined;

    if (!row) return null;
    return this.rowToVersion(row);
  }

  /** List all versions of a prompt, ordered by version number descending. */
  async listVersions(name: string): Promise<PromptVersion[]> {
    const rows = this.db
      .prepare(
        `SELECT v.*
         FROM prompt_versions v
         JOIN prompts p ON p.id = v.prompt_id
         WHERE p.name = @name
         ORDER BY v.version DESC`
      )
      .all({ name }) as Record<string, unknown>[];

    return rows.map((row) => this.rowToVersion(row));
  }

  /** Create a new version of a prompt. Auto-increments version number and extracts variables. */
  async createVersion(
    name: string,
    content: string,
    model?: string,
    activate?: boolean
  ): Promise<PromptVersion> {
    const prompt = this.db
      .prepare(`SELECT id FROM prompts WHERE name = @name`)
      .get({ name }) as { id: string } | undefined;

    if (!prompt) {
      const e = new Error(`Prompt "${name}" not found`);
      (e as Error & { code: string }).code = "NOT_FOUND";
      throw e;
    }

    const promptId = prompt.id;
    const variables = extractVariables(content);

    // Determine next version number
    const maxRow = this.db
      .prepare(`SELECT MAX(version) AS max_version FROM prompt_versions WHERE prompt_id = @promptId`)
      .get({ promptId }) as { max_version: number | null };
    const version = (maxRow.max_version ?? 0) + 1;

    const id = randomUUID();
    const now = new Date().toISOString();
    const isActive = activate ? 1 : 0;

    const insertVersion = this.db.transaction(() => {
      // If activating, deactivate all other versions first
      if (activate) {
        this.db
          .prepare(`UPDATE prompt_versions SET is_active = 0 WHERE prompt_id = @promptId`)
          .run({ promptId });
      }

      this.db
        .prepare(
          `INSERT INTO prompt_versions (id, prompt_id, version, content, model, variables, is_active, created_by, created_at)
           VALUES (@id, @promptId, @version, @content, @model, @variables, @isActive, @createdBy, @createdAt)`
        )
        .run({
          id,
          promptId,
          version,
          content,
          model: model ?? null,
          variables: JSON.stringify(variables),
          isActive,
          createdBy: "system",
          createdAt: now,
        });

      // Update prompt's updated_at timestamp
      this.db
        .prepare(`UPDATE prompts SET updated_at = @now WHERE id = @promptId`)
        .run({ now, promptId });
    });

    insertVersion();

    return {
      id,
      promptId,
      version,
      content,
      model: model ?? null,
      variables,
      isActive: !!activate,
      createdBy: "system",
      createdAt: now,
    };
  }

  /** Activate a specific version of a prompt, deactivating all others. */
  async activateVersion(name: string, version: number): Promise<void> {
    const prompt = this.db
      .prepare(`SELECT id FROM prompts WHERE name = @name`)
      .get({ name }) as { id: string } | undefined;

    if (!prompt) {
      const e = new Error(`Prompt "${name}" not found`);
      (e as Error & { code: string }).code = "NOT_FOUND";
      throw e;
    }

    const promptId = prompt.id;

    const versionRow = this.db
      .prepare(
        `SELECT id FROM prompt_versions WHERE prompt_id = @promptId AND version = @version`
      )
      .get({ promptId, version }) as { id: string } | undefined;

    if (!versionRow) {
      const e = new Error(`Version ${version} not found for prompt "${name}"`);
      (e as Error & { code: string }).code = "NOT_FOUND";
      throw e;
    }

    const activate = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE prompt_versions SET is_active = 0 WHERE prompt_id = @promptId`)
        .run({ promptId });
      this.db
        .prepare(
          `UPDATE prompt_versions SET is_active = 1 WHERE prompt_id = @promptId AND version = @version`
        )
        .run({ promptId, version });
      this.db
        .prepare(`UPDATE prompts SET updated_at = @now WHERE id = @promptId`)
        .run({ now: new Date().toISOString(), promptId });
    });

    activate();
  }

  /** Delete a prompt and all its versions. */
  async deletePrompt(name: string): Promise<void> {
    // Foreign key cascade handles prompt_versions deletion
    this.db.pragma("foreign_keys = ON");
    this.db.prepare(`DELETE FROM prompts WHERE name = @name`).run({ name });
  }

  private rowToVersion(row: Record<string, unknown>): PromptVersion {
    return {
      id: row.id as string,
      promptId: row.prompt_id as string,
      version: row.version as number,
      content: row.content as string,
      model: (row.model as string) ?? null,
      variables: safeJsonParse<string[]>(row.variables as string | null, []),
      isActive: (row.is_active as number) === 1,
      createdBy: row.created_by as string,
      createdAt: row.created_at as string,
    };
  }
}

function safeJsonParse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
