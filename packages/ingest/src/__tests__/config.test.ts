import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import { loadConfig, DEFAULTS } from "../config.js";

vi.mock("node:fs");

const mockedFs = vi.mocked(fs);

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", () => {
    mockedFs.existsSync.mockReturnValue(false);

    const cfg = loadConfig();

    expect(cfg).toEqual(DEFAULTS);
    expect(cfg.server.port).toBe(3000);
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.log_level).toBe("info");
    expect(cfg.storage.type).toBe("sqlite");
    expect(cfg.storage.path).toBe("./lantern.db");
    expect(cfg.export.batch_size).toBe(50);
    expect(cfg.export.flush_interval_ms).toBe(5000);
    expect(cfg.prompts?.enabled).toBe(true);
    expect(cfg.retention?.default_days).toBe(30);
  });

  it("loads and parses YAML config", () => {
    const yaml = `
version: "1"
server:
  port: 8080
  host: "0.0.0.0"
  log_level: debug
storage:
  type: postgres
  url: "postgres://localhost:5432/lantern"
export:
  batch_size: 100
  flush_interval_ms: 10000
auth:
  enabled: true
  api_keys:
    - "key-abc-123"
`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(yaml);

    const cfg = loadConfig("/path/to/lantern.yaml");

    expect(cfg.version).toBe("1");
    expect(cfg.server.port).toBe(8080);
    expect(cfg.server.host).toBe("0.0.0.0");
    expect(cfg.server.log_level).toBe("debug");
    expect(cfg.storage.type).toBe("postgres");
    expect(cfg.storage.url).toBe("postgres://localhost:5432/lantern");
    expect(cfg.export.batch_size).toBe(100);
    expect(cfg.export.flush_interval_ms).toBe(10000);
    expect(cfg.auth?.enabled).toBe(true);
    expect(cfg.auth?.api_keys).toEqual(["key-abc-123"]);
  });

  it("interpolates ${ENV_VAR} in YAML", () => {
    const yaml = `
version: "1"
storage:
  type: postgres
  url: "\${MY_DB_URL}"
auth:
  enabled: true
  api_keys:
    - "\${MY_API_KEY}"
`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(yaml);

    process.env.MY_DB_URL = "postgres://prod:5432/db";
    process.env.MY_API_KEY = "secret-key-value";

    try {
      const cfg = loadConfig("/path/to/lantern.yaml");
      expect(cfg.storage.url).toBe("postgres://prod:5432/db");
      expect(cfg.auth?.api_keys).toEqual(["secret-key-value"]);
    } finally {
      delete process.env.MY_DB_URL;
      delete process.env.MY_API_KEY;
    }
  });

  it("deep merges with defaults (partial config fills missing fields)", () => {
    const yaml = `
server:
  port: 9090
storage:
  type: sqlite
`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(yaml);

    const cfg = loadConfig("/path/to/lantern.yaml");

    // Specified values
    expect(cfg.server.port).toBe(9090);
    expect(cfg.storage.type).toBe("sqlite");

    // Defaults filled in
    expect(cfg.version).toBe("1");
    expect(cfg.server.host).toBe("127.0.0.1");
    expect(cfg.server.log_level).toBe("info");
    expect(cfg.storage.path).toBe("./lantern.db");
    expect(cfg.export.batch_size).toBe(50);
    expect(cfg.export.flush_interval_ms).toBe(5000);
    expect(cfg.prompts?.enabled).toBe(true);
    expect(cfg.retention?.default_days).toBe(30);
    // auth not provided, should be undefined
    expect(cfg.auth).toBeUndefined();
  });

  it("warns on missing env var", () => {
    const yaml = `
storage:
  url: "\${NONEXISTENT_VAR_12345}"
`;

    mockedFs.existsSync.mockReturnValue(true);
    mockedFs.readFileSync.mockReturnValue(yaml);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Make sure the env var doesn't exist
    delete process.env.NONEXISTENT_VAR_12345;

    const cfg = loadConfig("/path/to/lantern.yaml");

    expect(warnSpy).toHaveBeenCalledWith(
      "[lantern] Missing environment variable: NONEXISTENT_VAR_12345"
    );
    // Missing env var is replaced with empty string
    expect(cfg.storage.url).toBe("");
  });

  it("auto-discovers lantern.yaml in default locations", () => {
    mockedFs.existsSync.mockImplementation((path) => {
      return path === "./lantern.yaml";
    });
    mockedFs.readFileSync.mockReturnValue(`
server:
  port: 7777
`);

    const cfg = loadConfig();

    expect(cfg.server.port).toBe(7777);
    expect(mockedFs.readFileSync).toHaveBeenCalledWith("./lantern.yaml", "utf-8");
  });

  it("auto-discovers lantern.yml when lantern.yaml does not exist", () => {
    mockedFs.existsSync.mockImplementation((path) => {
      return path === "./lantern.yml";
    });
    mockedFs.readFileSync.mockReturnValue(`
server:
  port: 8888
`);

    const cfg = loadConfig();

    expect(cfg.server.port).toBe(8888);
    expect(mockedFs.readFileSync).toHaveBeenCalledWith("./lantern.yml", "utf-8");
  });
});
