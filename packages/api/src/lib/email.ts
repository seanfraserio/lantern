const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = "Lantern <noreply@openlanternai.com>";

export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  if (!RESEND_API_KEY) {
    console.log(`[email] Resend not configured. Would send to ${to}: ${subject}`);
    return false;
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
    });
    if (!response.ok) {
      console.error(`[email] Send failed: ${response.status}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[email] Send error:", err);
    return false;
  }
}

export function magicLinkEmail(url: string): { subject: string; html: string } {
  return {
    subject: "Sign in to Lantern",
    html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:40px 20px;">
      <h2 style="color:#1a1d27;">Sign in to Lantern</h2>
      <p style="color:#6b7280;">Click the button below to sign in. This link expires in 15 minutes.</p>
      <a href="${url}" style="display:inline-block;background:#4f6df5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin:16px 0;">Sign In</a>
      <p style="color:#9ca3af;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </div>`,
  };
}

export function passwordResetEmail(url: string): { subject: string; html: string } {
  return {
    subject: "Reset your Lantern password",
    html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:40px 20px;">
      <h2 style="color:#1a1d27;">Reset your password</h2>
      <p style="color:#6b7280;">Click the button below to reset your password. This link expires in 1 hour.</p>
      <a href="${url}" style="display:inline-block;background:#4f6df5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin:16px 0;">Reset Password</a>
      <p style="color:#9ca3af;font-size:13px;">If you didn't request this, you can safely ignore this email.</p>
    </div>`,
  };
}

export function teamInviteEmail(teamName: string, inviterEmail: string, loginUrl: string): { subject: string; html: string } {
  return {
    subject: `You've been invited to ${teamName} on Lantern`,
    html: `<div style="font-family:sans-serif;max-width:500px;margin:0 auto;padding:40px 20px;">
      <h2 style="color:#1a1d27;">You've been invited to ${teamName}</h2>
      <p style="color:#6b7280;">${inviterEmail} has invited you to join their team on Lantern.</p>
      <a href="${loginUrl}" style="display:inline-block;background:#4f6df5;color:white;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;margin:16px 0;">Accept Invitation</a>
      <p style="color:#9ca3af;font-size:13px;">Lantern — Agent observability for the enterprise</p>
    </div>`,
  };
}
