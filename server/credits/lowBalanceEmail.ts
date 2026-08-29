import { sendEmail } from "../email.js";

export async function sendLowBalanceEmail(
  to: string,
  balance: number,
  threshold: number
): Promise<void> {
  if (!process.env.RESEND_API_KEY) {
    console.warn("[LowBalance] RESEND_API_KEY not set — skipping low balance email");
    return;
  }

  const severity = threshold <= 10 ? "critical" : "low";
  const subject = severity === "critical"
    ? `Critical: Your credit balance is ${balance}`
    : `Your credit balance is running low (${balance} remaining)`;

  const html = `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px; background: #0a0a0a; color: #e5e5e5;">
      <h2 style="color: #fff; margin-bottom: 16px;">${severity === "critical" ? "Credit Balance Critical" : "Low Credit Balance"}</h2>
      <p style="color: #a3a3a3; font-size: 15px; line-height: 1.6;">
        Your current balance is <strong style="color: #fff;">${balance} credits</strong>.
        ${severity === "critical"
          ? "You may not be able to generate content without adding more credits."
          : "Consider topping up to avoid interruptions."}
      </p>
      <p style="color: #666; font-size: 13px; margin-top: 24px;">
        You can add credits from your account settings.
      </p>
    </div>
  `;

  try {
    await sendEmail(to, subject, html);
  } catch (err) {
    console.error("[LowBalance] Failed to send email:", err);
  }
}
