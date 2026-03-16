import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { magicLinkEmail, passwordResetEmail, teamInviteEmail, sendEmail } from "../email.js";

describe("magicLinkEmail", () => {
  it("returns correct subject", () => {
    const { subject } = magicLinkEmail("https://app.test/signin?token=abc");
    expect(subject).toBe("Sign in to Lantern");
  });

  it("includes the sign-in URL in the HTML", () => {
    const url = "https://app.test/signin?token=abc123";
    const { html } = magicLinkEmail(url);
    expect(html).toContain(url);
  });

  it("mentions expiry in the HTML", () => {
    const { html } = magicLinkEmail("https://app.test/signin?token=abc");
    expect(html).toMatch(/15 minutes/i);
  });

  it("contains a Sign In link with the URL as href", () => {
    const url = "https://app.test/signin?token=abc";
    const { html } = magicLinkEmail(url);
    expect(html).toContain(`href="${url}"`);
  });
});

describe("passwordResetEmail", () => {
  it("returns correct subject", () => {
    const { subject } = passwordResetEmail("https://app.test/reset?token=xyz");
    expect(subject).toBe("Reset your Lantern password");
  });

  it("includes the reset URL in the HTML", () => {
    const url = "https://app.test/reset?token=xyz";
    const { html } = passwordResetEmail(url);
    expect(html).toContain(url);
    expect(html).toContain(`href="${url}"`);
  });

  it("mentions 1 hour expiry", () => {
    const { html } = passwordResetEmail("https://app.test/reset?token=xyz");
    expect(html).toMatch(/1 hour/i);
  });
});

describe("teamInviteEmail", () => {
  it("includes team name and inviter email in subject", () => {
    const { subject } = teamInviteEmail("Engineering", "alice@acme.com", "https://app.test/login");
    expect(subject).toContain("Engineering");
  });

  it("includes inviter email and login URL in HTML", () => {
    const { html } = teamInviteEmail("Engineering", "alice@acme.com", "https://app.test/login");
    expect(html).toContain("alice@acme.com");
    expect(html).toContain("https://app.test/login");
    expect(html).toContain("Engineering");
  });
});

describe("sendEmail", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.RESEND_API_KEY;
  });

  it("returns false and logs when RESEND_API_KEY is not set", async () => {
    delete process.env.RESEND_API_KEY;
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await sendEmail("user@test.com", "Test Subject", "<p>Hello</p>");

    expect(result).toBe(false);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("not configured"));
    consoleSpy.mockRestore();
  });

  it("calls Resend API and returns true on success", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const result = await sendEmail("user@test.com", "Test Subject", "<p>Hello</p>");

    expect(result).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer re_test_key" }),
      })
    );
  });

  it("returns false when Resend API returns non-ok response", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
    } as Response);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendEmail("user@test.com", "Test", "<p>Body</p>");

    expect(result).toBe(false);
    consoleSpy.mockRestore();
  });

  it("returns false when fetch throws", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    global.fetch = vi.fn().mockRejectedValue(new Error("network error"));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await sendEmail("user@test.com", "Test", "<p>Body</p>");

    expect(result).toBe(false);
    consoleSpy.mockRestore();
  });
});
