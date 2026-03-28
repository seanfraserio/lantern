import yaml from "js-yaml";
import fs from "node:fs";

export interface PubSubIngestionConfig {
  enabled: boolean;
  subscription_name: string;
  project_id?: string;
}

export interface CloudTasksEvalConfig {
  enabled: boolean;
  project_id: string;
  location: string;
  queue: string;
  worker_url: string;
}

export interface LanternConfig {
  version: "1";
  server: {
    port: number;
    host: string;
    log_level: string;
  };
  storage: {
    type: "sqlite" | "postgres";
    path?: string;
    url?: string;
  };
  export: {
    batch_size: number;
    flush_interval_ms: number;
  };
  auth?: {
    enabled: boolean;
    api_keys: string[];
  };
  prompts?: {
    enabled: boolean;
  };
  retention?: {
    default_days: number;
  };
  ingestion?: {
    pubsub?: PubSubIngestionConfig;
  };
  evaluation?: {
    cloud_tasks?: CloudTasksEvalConfig;
  };
}

const DEFAULTS: LanternConfig = {
  version: "1",
  server: { port: 3000, host: "127.0.0.1", log_level: "info" },
  storage: { type: "sqlite", path: "./lantern.db" },
  export: { batch_size: 50, flush_interval_ms: 5000 },
  prompts: { enabled: true },
  retention: { default_days: 30 },
};

export { DEFAULTS };

export function loadConfig(filePath?: string): LanternConfig {
  if (!filePath) {
    // Try default locations
    const candidates = ["./lantern.yaml", "./lantern.yml"];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        filePath = candidate;
        break;
      }
    }
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return DEFAULTS;
  }

  const raw = fs.readFileSync(filePath, "utf-8");

  // Interpolate ${ENV_VAR}
  const interpolated = raw.replace(/\$\{(\w+)\}/g, (_, name) => {
    const value = process.env[name];
    if (value === undefined) {
      console.warn(`[lantern] Missing environment variable: ${name}`);
    }
    return value ?? "";
  });

  const parsed = yaml.load(interpolated, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>;

  const p = parsed as {
    version?: string;
    server?: Partial<LanternConfig["server"]>;
    storage?: Partial<LanternConfig["storage"]>;
    export?: Partial<LanternConfig["export"]>;
    auth?: LanternConfig["auth"];
    prompts?: Partial<NonNullable<LanternConfig["prompts"]>>;
    retention?: Partial<NonNullable<LanternConfig["retention"]>>;
    ingestion?: LanternConfig["ingestion"];
    evaluation?: LanternConfig["evaluation"];
  };

  // Deep merge with defaults
  return {
    version: (p.version as LanternConfig["version"]) ?? DEFAULTS.version,
    server: { ...DEFAULTS.server, ...p.server },
    storage: { ...DEFAULTS.storage, ...p.storage },
    export: { ...DEFAULTS.export, ...p.export },
    auth: p.auth,
    prompts: {
      enabled: p.prompts?.enabled ?? DEFAULTS.prompts!.enabled,
    },
    retention: {
      default_days: p.retention?.default_days ?? DEFAULTS.retention!.default_days,
    },
    ingestion: p.ingestion,
    evaluation: p.evaluation,
  };
}
