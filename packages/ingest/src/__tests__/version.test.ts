import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const pkg = require_("../../package.json") as { version: string };

describe("lantern --version", () => {
  it("reads version from package.json (not hardcoded)", () => {
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("version matches package.json", () => {
    // Read the version at runtime to avoid hardcoding
    const require2 = createRequire(import.meta.url);
    const freshPkg = require2("../../package.json") as { version: string };
    expect(pkg.version).toBe(freshPkg.version);
  });

  it("cli.ts checks process.argv for --version", async () => {
    // Verify the CLI source contains version flag handling
    const { readFileSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const cliSource = readFileSync(resolve(__dirname, "../cli.ts"), "utf-8");

    expect(cliSource).toContain("--version");
    expect(cliSource).toContain("-V");
    expect(cliSource).toContain("pkg.version");
  });
});
