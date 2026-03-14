import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword } from "./passwords.js";

describe("passwords", () => {
  it("should hash and verify a password", async () => {
    const hash = await hashPassword("test-password-123");
    expect(hash).not.toBe("test-password-123");
    expect(await verifyPassword("test-password-123", hash)).toBe(true);
    expect(await verifyPassword("wrong-password", hash)).toBe(false);
  });
});
