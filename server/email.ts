import type { Resend } from "resend";
import { createRequire } from "node:module";

// Type-only import + lazy require: email is unused in the local build (no
// RESEND_API_KEY), so the `resend` package is never loaded and can be dropped
// from the bundle.
const nodeRequire = createRequire(import.meta.url);

if (!process.env.RESEND_API_KEY) {
  console.warn("[Email] WARNING: RESEND_API_KEY is not set — invitation, verification, and email change emails will not be sent");
} else {
  console.log("[Email] Resend API key configured — email sending enabled");
}

// Only construct the client when a key exists — this Resend version throws on
// an undefined key. Email is optional (and unused in the local build).
const resend: Resend | null = process.env.RESEND_API_KEY
  ? new (nodeRequire("resend").Resend as typeof Resend)(process.env.RESEND_API_KEY)
  : null;

const FROM_EMAIL = process.env.EMAIL_FROM || "onboarding@resend.dev";

export async function sendEmail(to: string, subject: string, html: string) {
  if (!resend) {
    throw new Error("Email is not configured (RESEND_API_KEY not set).");
  }
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to,
    subject,
    html,
  });
  if (result.error) {
    console.error("Resend error:", result.error);
    throw new Error(result.error.message);
  }
  return result.data;
}

function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendInvitationEmail(opts: {
  to: string;
  token: string;
  workspaceName: string;
  inviterName: string;
  role: string;
}): Promise<{ sent: boolean; error?: string }> {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[Invitation] RESEND_API_KEY not set — skipping invitation email");
    return { sent: false, error: "Email service not configured" };
  }

  const baseUrl = process.env.APP_URL || "http://localhost:5000";
  const inviteUrl = `${baseUrl}/invite?token=${opts.token}`;
  const roleName = opts.role.charAt(0).toUpperCase() + opts.role.slice(1);
  const safeInviterName = escapeHtml(opts.inviterName);
  const safeWorkspaceName = escapeHtml(opts.workspaceName);
  const safeRoleName = escapeHtml(roleName);

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0a0a0a; color: #e5e5e5;">
      <h2 style="color: #fff; margin-bottom: 16px;">You've been invited</h2>
      <p style="color: #a3a3a3; font-size: 15px; line-height: 1.6;">
        <strong style="color: #fff;">${safeInviterName}</strong> has invited you to join
        <strong style="color: #fff;">${safeWorkspaceName}</strong> as a <strong style="color: #fff;">${safeRoleName}</strong>.
      </p>
      <a href="${inviteUrl}" style="display: inline-block; background: #fff; color: #000; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 600; margin: 24px 0;">
        Join Team
      </a>
      <p style="color: #666; font-size: 13px; margin-top: 24px;">
        This invitation expires in 7 days. If you didn't expect this email, you can safely ignore it.
      </p>
    </div>
  `;

  try {
    await sendEmail(opts.to, `You're invited to join team ${opts.workspaceName}`, html);
    return { sent: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Unknown email error";
    console.error("[Invitation] Failed to send email:", message);
    return { sent: false, error: message };
  }
}

export async function sendVerificationEmail(to: string, token: string) {
  const baseUrl = process.env.APP_URL || "http://localhost:5000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #111; margin-bottom: 16px;">Verify your email</h2>
      <p style="color: #555; font-size: 15px; line-height: 1.6;">
        Thanks for signing up! Please verify your email address by clicking the button below.
      </p>
      <a href="${verifyUrl}" style="display: inline-block; background: #111; color: #fff; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 500; margin: 24px 0;">
        Verify Email
      </a>
      <p style="color: #999; font-size: 13px; margin-top: 24px;">
        This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
      </p>
    </div>
  `;

  return sendEmail(to, "Verify your email address", html);
}

export async function sendEmailChangeVerification(to: string, token: string) {
  const baseUrl = process.env.APP_URL || "http://localhost:5000";
  const verifyUrl = `${baseUrl}/verify-email?token=${token}`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
      <h2 style="color: #111; margin-bottom: 16px;">Confirm your new email</h2>
      <p style="color: #555; font-size: 15px; line-height: 1.6;">
        You requested to change your email address. Please confirm this new address by clicking the button below.
      </p>
      <a href="${verifyUrl}" style="display: inline-block; background: #111; color: #fff; padding: 12px 32px; border-radius: 6px; text-decoration: none; font-weight: 500; margin: 24px 0;">
        Confirm Email Change
      </a>
      <p style="color: #999; font-size: 13px; margin-top: 24px;">
        This link expires in 24 hours. If you didn't request this change, you can safely ignore this email.
      </p>
    </div>
  `;

  return sendEmail(to, "Confirm your email change", html);
}
