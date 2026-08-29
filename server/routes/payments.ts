import { Router, Request, Response } from "express";
import { pool } from "../db.js";
import {
  requireStripe,
  isStripeConfigured,
  requireWebhookSecret,
  CREDITS_PER_DOLLAR,
  PLAN_CONFIG,
  MAX_PURCHASE_CENTS,
  MIN_PURCHASE_CENTS,
} from "../stripe.js";
import { grantWorkspaceCredits } from "../credits/creditGate.js";

interface AuthRequest extends Request {
  userId?: string;
}

const router = Router();

function ensureStripeConfigured(req: Request, res: Response, next: Function) {
  if (!isStripeConfigured()) {
    res.status(503).json({ error: "Payment processing is not configured" });
    return;
  }
  next();
}

const checkoutRateLimits = new Map<string, number[]>();

function checkCheckoutRateLimit(userId: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 60 * 1000;
  const maxRequests = 10;

  let timestamps = checkoutRateLimits.get(userId) || [];
  timestamps = timestamps.filter((t) => now - t < windowMs);

  if (timestamps.length >= maxRequests) {
    checkoutRateLimits.set(userId, timestamps);
    return false;
  }

  timestamps.push(now);
  checkoutRateLimits.set(userId, timestamps);
  return true;
}

function getSubscriptionPeriod(sub: unknown): { start: number | undefined; end: number | undefined } {
  const s = sub as {
    current_period_start?: number;
    current_period_end?: number;
    items?: { data?: Array<{ current_period_start?: number; current_period_end?: number }> };
  };
  let start = s?.current_period_start;
  let end = s?.current_period_end;
  if (!start || !end) {
    const item = s?.items?.data?.[0];
    if (item) {
      start = start || item.current_period_start;
      end = end || item.current_period_end;
    }
  }
  return { start, end };
}

async function getOrCreateStripeCustomer(userId: string): Promise<string> {
  const userResult = await pool.query(
    `SELECT id, email, stripe_customer_id FROM users WHERE id = $1`,
    [userId]
  );

  if (userResult.rows.length === 0) {
    throw new Error("User not found");
  }

  const user = userResult.rows[0];

  if (user.stripe_customer_id) {
    return user.stripe_customer_id;
  }

  const customer = await requireStripe().customers.create({
    email: user.email,
    metadata: { app_user_id: userId },
  });

  await pool.query(
    `UPDATE users SET stripe_customer_id = $1 WHERE id = $2 AND stripe_customer_id IS NULL`,
    [customer.id, userId]
  );

  const verify = await pool.query(
    `SELECT stripe_customer_id FROM users WHERE id = $1`,
    [userId]
  );

  return verify.rows[0].stripe_customer_id;
}

function centsToCredits(cents: number): number {
  return Math.floor((cents / 100) * CREDITS_PER_DOLLAR);
}

async function verifyWorkspaceAdmin(userId: string, workspaceId: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT wm.role FROM workspace_members wm
     JOIN workspaces w ON w.id = wm.workspace_id
     WHERE wm.workspace_id = $1 AND wm.user_id = $2 AND w.type = 'org' AND wm.role IN ('owner', 'admin')`,
    [workspaceId, userId]
  );
  return result.rows.length > 0;
}

router.post("/api/payments/checkout/credits", ensureStripeConfigured, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    if (!checkCheckoutRateLimit(userId)) {
      res.status(429).json({ error: "Too many checkout requests. Try again later." });
      return;
    }

    const { amount, workspace_id } = req.body;
    const amountCents = Math.floor(Number(amount));

    if (!Number.isFinite(amountCents) || amountCents < MIN_PURCHASE_CENTS) {
      res.status(400).json({ error: `Minimum purchase is $${(MIN_PURCHASE_CENTS / 100).toFixed(2)}` });
      return;
    }

    if (amountCents > MAX_PURCHASE_CENTS) {
      res.status(400).json({ error: `Maximum purchase is $${(MAX_PURCHASE_CENTS / 100).toFixed(2)}` });
      return;
    }

    if (workspace_id) {
      const isAdmin = await verifyWorkspaceAdmin(userId, workspace_id);
      if (!isAdmin) {
        res.status(403).json({ error: "Only workspace owners or admins can purchase credits for a workspace" });
        return;
      }
    }

    const creditsToGrant = centsToCredits(amountCents);
    const customerId = await getOrCreateStripeCustomer(userId);

    const baseUrl = process.env.APP_URL || "http://localhost:5000";

    const sessionMetadata: Record<string, string> = {
      user_id: userId,
      type: "credit_purchase",
      credits: String(creditsToGrant),
    };
    if (workspace_id) {
      sessionMetadata.workspace_id = workspace_id;
    }

    const session = await requireStripe().checkout.sessions.create({
      customer: customerId,
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: workspace_id ? `${creditsToGrant} Workspace Credits` : `${creditsToGrant} Credits`,
              description: workspace_id
                ? `One-time purchase of ${creditsToGrant} credits for workspace`
                : `One-time purchase of ${creditsToGrant} credits`,
            },
          },
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      metadata: sessionMetadata,
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/canceled`,
    });

    await pool.query(
      `INSERT INTO purchases (user_id, workspace_id, stripe_session_id, amount_cents, credits_granted, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       ON CONFLICT (stripe_session_id) DO NOTHING`,
      [userId, workspace_id || null, session.id, amountCents, creditsToGrant]
    );

    res.json({ url: session.url });
  } catch (err) {
    console.error("[payments] checkout/credits error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

router.post("/api/payments/checkout/subscription", ensureStripeConfigured, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    if (!checkCheckoutRateLimit(userId)) {
      res.status(429).json({ error: "Too many checkout requests. Try again later." });
      return;
    }

    const { plan, workspace_id } = req.body;

    if (!plan || !PLAN_CONFIG[plan]) {
      res.status(400).json({ error: "Invalid plan. Must be one of: starter, pro, power" });
      return;
    }

    if (workspace_id) {
      const isAdmin = await verifyWorkspaceAdmin(userId, workspace_id);
      if (!isAdmin) {
        res.status(403).json({ error: "Only workspace owners or admins can purchase subscriptions for a workspace" });
        return;
      }
    }

    const planCfg = PLAN_CONFIG[plan];
    const customerId = await getOrCreateStripeCustomer(userId);

    const existingSubQuery = workspace_id
      ? await pool.query(
          `SELECT id, stripe_subscription_id, plan_tier, credits_per_period FROM subscriptions WHERE workspace_id = $1 AND status = 'active'`,
          [workspace_id]
        )
      : await pool.query(
          `SELECT id, stripe_subscription_id, plan_tier, credits_per_period FROM subscriptions WHERE user_id = $1 AND workspace_id IS NULL AND status = 'active'`,
          [userId]
        );

    if (existingSubQuery.rows.length > 0) {
      const existingSub = existingSubQuery.rows[0];

      if (existingSub.plan_tier === plan) {
        res.status(400).json({ error: "You are already on this plan." });
        return;
      }

      try {
        const stripeSub = await requireStripe().subscriptions.retrieve(existingSub.stripe_subscription_id);
        const currentItemId = stripeSub.items.data[0]?.id;
        if (!currentItemId) {
          res.status(500).json({ error: "Could not find current subscription item. Please contact support." });
          return;
        }

        const updatedSub = await requireStripe().subscriptions.update(existingSub.stripe_subscription_id, {
          items: [
            {
              id: currentItemId,
              price: planCfg.priceId,
            },
          ],
          metadata: {
            user_id: userId,
            plan_tier: plan,
            ...(workspace_id ? { workspace_id } : {}),
          },
          proration_behavior: "create_prorations",
        });

        const { start: psRaw, end: peRaw } = getSubscriptionPeriod(updatedSub);
        const periodStart = safeTimestampToDate(psRaw);
        const periodEnd = safeTimestampToDate(peRaw);

        const client = await pool.connect();
        try {
          await client.query("BEGIN");

          await client.query(
            `UPDATE subscriptions SET plan_tier = $1, credits_per_period = $2, current_period_start = COALESCE($3, current_period_start), current_period_end = COALESCE($4, current_period_end), updated_at = NOW()
             WHERE stripe_subscription_id = $5`,
            [plan, planCfg.creditsPerPeriod, periodStart, periodEnd, existingSub.stripe_subscription_id]
          );

          const oldCreditsPerPeriod = existingSub.credits_per_period ?? (PLAN_CONFIG[existingSub.plan_tier]?.creditsPerPeriod || 0);
          const newCreditsPerPeriod = planCfg.creditsPerPeriod;
          const creditDiff = newCreditsPerPeriod - oldCreditsPerPeriod;

          if (creditDiff !== 0) {
            const isUpgrade = creditDiff > 0;
            const absDiff = Math.abs(creditDiff);

            if (workspace_id) {
              if (isUpgrade) {
                const updated = await client.query(
                  `INSERT INTO workspace_credits (workspace_id, balance) VALUES ($1, $2)
                   ON CONFLICT (workspace_id) DO UPDATE SET balance = workspace_credits.balance + $2, updated_at = NOW()
                   RETURNING balance`,
                  [workspace_id, absDiff]
                );
                const newBalance = updated.rows[0].balance;
                await client.query(
                  `INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [userId, workspace_id, absDiff, newBalance, "subscription:upgrade"]
                );
              } else {
                const prior = await client.query(
                  `SELECT balance FROM workspace_credits WHERE workspace_id = $1 FOR UPDATE`,
                  [workspace_id]
                );
                const oldBalance = prior.rows[0]?.balance || 0;
                const newBalance = Math.max(0, oldBalance - absDiff);
                const actualDeducted = oldBalance - newBalance;
                await client.query(
                  `UPDATE workspace_credits SET balance = $1, updated_at = NOW() WHERE workspace_id = $2`,
                  [newBalance, workspace_id]
                );
                await client.query(
                  `INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason)
                   VALUES ($1, $2, $3, $4, $5)`,
                  [userId, workspace_id, -actualDeducted, newBalance, "subscription:downgrade"]
                );
              }
            } else {
              if (isUpgrade) {
                const updated = await client.query(
                  `INSERT INTO credits (user_id, balance) VALUES ($1, $2)
                   ON CONFLICT (user_id) DO UPDATE SET balance = credits.balance + $2, updated_at = NOW()
                   RETURNING balance`,
                  [userId, absDiff]
                );
                const newBalance = updated.rows[0].balance;
                await client.query(
                  `INSERT INTO credit_ledger (user_id, amount, balance_after, reason)
                   VALUES ($1, $2, $3, $4)`,
                  [userId, absDiff, newBalance, "subscription:upgrade"]
                );
              } else {
                const prior = await client.query(
                  `SELECT balance FROM credits WHERE user_id = $1 FOR UPDATE`,
                  [userId]
                );
                const oldBalance = prior.rows[0]?.balance || 0;
                const newBalance = Math.max(0, oldBalance - absDiff);
                const actualDeducted = oldBalance - newBalance;
                await client.query(
                  `INSERT INTO credits (user_id, balance) VALUES ($1, $2)
                   ON CONFLICT (user_id) DO UPDATE SET balance = $2, updated_at = NOW()`,
                  [userId, newBalance]
                );
                await client.query(
                  `INSERT INTO credit_ledger (user_id, amount, balance_after, reason)
                   VALUES ($1, $2, $3, $4)`,
                  [userId, -actualDeducted, newBalance, "subscription:downgrade"]
                );
              }
            }

            console.log(`[payments] Adjusted credits by ${creditDiff} for ${workspace_id ? `workspace ${workspace_id}` : `user ${userId}`} (${existingSub.plan_tier} → ${plan})`);
          }

          await client.query("COMMIT");
        } catch (txErr) {
          await client.query("ROLLBACK");
          throw txErr;
        } finally {
          client.release();
        }

        const isUpgradeChange = planCfg.creditsPerPeriod > (existingSub.credits_per_period ?? 0);
        console.log(`[payments] Successfully ${isUpgradeChange ? "upgraded" : "downgraded"} subscription ${existingSub.stripe_subscription_id} from ${existingSub.plan_tier} to ${plan}`);
        res.json({ upgraded: true, changed: true, direction: isUpgradeChange ? "upgrade" : "downgrade", plan });
        return;
      } catch (upgradeErr) {
        console.error("[payments] subscription upgrade error:", upgradeErr);
        res.status(500).json({ error: "Failed to upgrade subscription. Please try again or contact support." });
        return;
      }
    }

    const baseUrl = process.env.APP_URL || "http://localhost:5000";

    const sessionMetadata: Record<string, string> = {
      user_id: userId,
      type: "subscription",
      plan_tier: plan,
    };
    if (workspace_id) {
      sessionMetadata.workspace_id = workspace_id;
    }

    const subMetadata: Record<string, string> = {
      user_id: userId,
      plan_tier: plan,
    };
    if (workspace_id) {
      subMetadata.workspace_id = workspace_id;
    }

    const session = await requireStripe().checkout.sessions.create({
      customer: customerId,
      mode: "subscription",
      line_items: [
        {
          price: planCfg.priceId,
          quantity: 1,
        },
      ],
      allow_promotion_codes: true,
      metadata: sessionMetadata,
      subscription_data: {
        metadata: subMetadata,
      },
      success_url: `${baseUrl}/payment/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/payment/canceled`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[payments] checkout/subscription error:", err);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

router.post("/api/payments/portal", ensureStripeConfigured, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;

    const userResult = await pool.query(
      `SELECT stripe_customer_id FROM users WHERE id = $1`,
      [userId]
    );

    if (userResult.rows.length === 0 || !userResult.rows[0].stripe_customer_id) {
      res.status(400).json({ error: "No billing account found. Make a purchase first." });
      return;
    }

    const baseUrl = process.env.APP_URL || "http://localhost:5000";
    const returnUrl = `${baseUrl}/settings`;

    const session = await requireStripe().billingPortal.sessions.create({
      customer: userResult.rows[0].stripe_customer_id,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("[payments] portal error:", err);
    res.status(500).json({ error: "Failed to create portal session" });
  }
});

router.get("/api/payments/subscription", async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const workspaceId = req.query.workspace_id as string | undefined;

    let result;
    if (workspaceId) {
      const memberCheck = await pool.query(
        `SELECT wm.role FROM workspace_members wm
         WHERE wm.workspace_id = $1 AND wm.user_id = $2`,
        [workspaceId, userId]
      );
      if (memberCheck.rows.length === 0) {
        res.status(403).json({ error: "Not a member of this workspace" });
        return;
      }

      result = await pool.query(
        `SELECT id, plan_tier, status, current_period_start, current_period_end, credits_per_period, workspace_id, created_at
         FROM subscriptions
         WHERE workspace_id = $1 AND status IN ('active', 'past_due')
         ORDER BY created_at DESC LIMIT 1`,
        [workspaceId]
      );
    } else {
      result = await pool.query(
        `SELECT id, plan_tier, status, current_period_start, current_period_end, credits_per_period, workspace_id, created_at
         FROM subscriptions
         WHERE user_id = $1 AND workspace_id IS NULL AND status IN ('active', 'past_due')
         ORDER BY created_at DESC LIMIT 1`,
        [userId]
      );
    }

    if (result.rows.length === 0) {
      res.json({ subscription: null });
      return;
    }

    const sub = result.rows[0];

    let currentBalance: number;
    if (sub.workspace_id) {
      const creditsResult = await pool.query(
        `SELECT balance FROM workspace_credits WHERE workspace_id = $1`,
        [sub.workspace_id]
      );
      currentBalance = creditsResult.rows.length > 0 ? creditsResult.rows[0].balance : 0;
    } else {
      const creditsResult = await pool.query(
        `SELECT balance FROM credits WHERE user_id = $1`,
        [userId]
      );
      currentBalance = creditsResult.rows.length > 0 ? creditsResult.rows[0].balance : 0;
    }

    res.json({
      subscription: {
        id: sub.id,
        planTier: sub.plan_tier,
        status: sub.status,
        currentPeriodStart: sub.current_period_start,
        currentPeriodEnd: sub.current_period_end,
        creditsPerPeriod: sub.credits_per_period,
        creditsRemaining: currentBalance,
        workspaceId: sub.workspace_id || null,
      },
    });
  } catch (err) {
    console.error("[payments] subscription error:", err);
    res.status(500).json({ error: "Failed to get subscription" });
  }
});

async function grantCreditsAtomically(
  userId: string,
  credits: number,
  reason: string,
  referenceId: string,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `WITH credit_update AS (
         INSERT INTO credits (user_id, balance)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = credits.balance + $2, updated_at = NOW()
         RETURNING balance
       ),
       ledger_insert AS (
         INSERT INTO credit_ledger (user_id, amount, balance_after, reason, reference_id, metadata)
         SELECT $1, $2, c.balance, $3, $4, $5
         FROM credit_update c
         ON CONFLICT (reason, reference_id) WHERE reference_id IS NOT NULL DO NOTHING
         RETURNING id
       )
       SELECT l.id AS ledger_id, c.balance AS new_balance
       FROM ledger_insert l, credit_update c`,
      [userId, credits, reason, referenceId, JSON.stringify(metadata)]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      console.log(`[payments] Credits already granted for ${reason} ref=${referenceId}`);
      return false;
    }

    await client.query("COMMIT");
    console.log(`[payments] Granted ${credits} credits to user=${userId}, reason=${reason}`);
    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505") {
      console.log(`[payments] Duplicate credit grant prevented for ${reason}`);
      return false;
    }
    throw err;
  } finally {
    client.release();
  }
}

async function grantPurchaseCreditsAtomically(
  userId: string,
  credits: number,
  sessionId: string,
  paymentIntentId: string | null,
  workspaceId?: string | null
): Promise<void> {
  if (workspaceId) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const purchaseResult = await client.query(
        `UPDATE purchases SET stripe_payment_intent_id = $1, status = 'completed'
         WHERE stripe_session_id = $2 AND status = 'pending' AND user_id = $3 AND credits_granted = $4
         RETURNING id`,
        [paymentIntentId, sessionId, userId, credits]
      );

      if (purchaseResult.rows.length === 0) {
        const alreadyCompleted = await client.query(
          `SELECT id FROM purchases WHERE stripe_session_id = $1 AND status = 'completed'`,
          [sessionId]
        );
        await client.query("ROLLBACK");
        if (alreadyCompleted.rows.length > 0) {
          console.log(`[payments] Purchase already completed for session=${sessionId}, ensuring workspace credits granted`);
          await grantWorkspaceCredits(workspaceId, credits, userId, "purchase", sessionId, {
            type: "one_time_purchase",
            session_id: sessionId,
            payment_intent: paymentIntentId,
            credits_granted: credits,
            workspace_id: workspaceId,
          });
          return;
        }
        throw new Error(`No matching pending purchase for session=${sessionId} user=${userId} credits=${credits}`);
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    await grantWorkspaceCredits(workspaceId, credits, userId, "purchase", sessionId, {
      type: "one_time_purchase",
      session_id: sessionId,
      payment_intent: paymentIntentId,
      credits_granted: credits,
      workspace_id: workspaceId,
    });
    console.log(`[payments] Granted ${credits} workspace purchase credits to workspace=${workspaceId}, session=${sessionId}`);
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const purchaseResult = await client.query(
      `UPDATE purchases SET stripe_payment_intent_id = $1, status = 'completed'
       WHERE stripe_session_id = $2 AND status = 'pending' AND user_id = $3 AND credits_granted = $4
       RETURNING id`,
      [paymentIntentId, sessionId, userId, credits]
    );

    if (purchaseResult.rows.length === 0) {
      const alreadyCompleted = await client.query(
        `SELECT id FROM purchases WHERE stripe_session_id = $1 AND status = 'completed'`,
        [sessionId]
      );
      await client.query("ROLLBACK");
      if (alreadyCompleted.rows.length > 0) {
        console.log(`[payments] Purchase already completed for session=${sessionId}`);
        return;
      }
      throw new Error(`No matching pending purchase for session=${sessionId} user=${userId} credits=${credits}`);
    }

    const grantResult = await client.query(
      `WITH credit_update AS (
         INSERT INTO credits (user_id, balance)
         VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET balance = credits.balance + $2, updated_at = NOW()
         RETURNING balance
       ),
       ledger_insert AS (
         INSERT INTO credit_ledger (user_id, amount, balance_after, reason, reference_id, metadata)
         SELECT $1, $2, c.balance, 'purchase', $3, $4
         FROM credit_update c
         ON CONFLICT (reason, reference_id) WHERE reference_id IS NOT NULL DO NOTHING
         RETURNING id
       )
       SELECT l.id AS ledger_id FROM ledger_insert l`,
      [userId, credits, sessionId, JSON.stringify({
        type: "one_time_purchase",
        session_id: sessionId,
        payment_intent: paymentIntentId,
        credits_granted: credits,
      })]
    );

    if (grantResult.rows.length === 0) {
      await client.query("ROLLBACK");
      console.log(`[payments] Credits already granted for purchase session=${sessionId}`);
      return;
    }

    await client.query("COMMIT");
    console.log(`[payments] Granted ${credits} purchase credits to user=${userId}, session=${sessionId}`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function safeTimestampToDate(val: unknown): Date | null {
  if (val === undefined || val === null) return null;
  const num = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(num) || num <= 0) return null;
  const date = new Date(num * 1000);
  if (isNaN(date.getTime())) return null;
  return date;
}

async function upsertSubscriptionFromStripe(
  userId: string,
  subId: string,
  customerId: string | null,
  planTier: string,
  planCfg: { creditsPerPeriod: number },
  initialStatus: "incomplete" | "active" = "incomplete",
  workspaceId?: string | null,
  eventPeriodStart?: Date | null,
  eventPeriodEnd?: Date | null
): Promise<void> {
  let periodStart: Date | null = eventPeriodStart || null;
  let periodEnd: Date | null = eventPeriodEnd || null;

  if (!periodStart || !periodEnd) {
    try {
      const sub = await requireStripe().subscriptions.retrieve(subId);
      const { start, end } = getSubscriptionPeriod(sub);
      periodStart = periodStart || safeTimestampToDate(start);
      periodEnd = periodEnd || safeTimestampToDate(end);
      if (!periodStart || !periodEnd) {
        console.warn(`[webhook] Subscription ${subId} has invalid period timestamps after API retrieve: start=${start}, end=${end}`);
      }
    } catch (err) {
      console.error("[webhook] Failed to retrieve subscription details:", err);
    }
  }

  await pool.query(
    `INSERT INTO subscriptions (user_id, stripe_subscription_id, stripe_customer_id, plan_tier, status, current_period_start, current_period_end, credits_per_period, workspace_id)
     VALUES ($1, $2, $3, $4, $8, $5, $6, $7, $9)
     ON CONFLICT (stripe_subscription_id) DO UPDATE SET
       plan_tier = $4,
       status = CASE WHEN $8::text = 'active' THEN 'active' ELSE subscriptions.status END,
       current_period_start = COALESCE($5, subscriptions.current_period_start),
       current_period_end = COALESCE($6, subscriptions.current_period_end),
       credits_per_period = $7,
       workspace_id = COALESCE($9, subscriptions.workspace_id),
       updated_at = NOW()`,
    [userId, subId, customerId, planTier, periodStart, periodEnd, planCfg.creditsPerPeriod, initialStatus, workspaceId || null]
  );
}

async function handleCheckoutCompleted(session: {
  id: string;
  mode: string;
  payment_status?: string;
  metadata: Record<string, string> | null;
  subscription?: string | null;
  payment_intent?: string | null;
  customer?: string | null;
}) {
  const metadata = session.metadata || {};
  const userId = metadata.user_id;
  const workspaceId = metadata.workspace_id || null;

  if (!userId) {
    console.error("[webhook] checkout.session.completed missing user_id in metadata");
    return;
  }

  if (session.mode === "payment") {
    if (session.payment_status !== "paid") {
      console.log(`[webhook] Skipping credit grant — payment_status is '${session.payment_status}', not 'paid'`);
      return;
    }

    const credits = parseInt(metadata.credits || "0", 10);
    if (credits <= 0) {
      console.error("[webhook] Invalid credits in metadata:", metadata.credits);
      return;
    }

    await grantPurchaseCreditsAtomically(userId, credits, session.id, session.payment_intent || null, workspaceId);
  }

  if (session.mode === "subscription" && session.subscription) {
    const planTier = metadata.plan_tier;
    const planCfg = planTier ? PLAN_CONFIG[planTier] : null;

    if (!planCfg || !planTier) {
      console.error("[webhook] Unknown plan_tier:", planTier);
      return;
    }

    const subId = typeof session.subscription === "string" ? session.subscription : (session.subscription as unknown as { id: string }).id;

    await upsertSubscriptionFromStripe(userId, subId, session.customer || null, planTier, planCfg, "incomplete", workspaceId);
  }
}

async function handleInvoicePaid(invoice: {
  id: string;
  subscription?: string | { id: string } | null;
  billing_reason?: string | null;
  customer?: string | null;
}) {
  let subIdStr: string | null = null;

  if (invoice.subscription) {
    subIdStr = typeof invoice.subscription === "string"
      ? invoice.subscription
      : (invoice.subscription as { id: string }).id;
  }

  if (!subIdStr) {
    console.log(`[webhook] invoice.paid: subscription field missing on invoice ${invoice.id}, looking up from Stripe`);
    try {
      const stripeInvoice = await requireStripe().invoices.retrieve(invoice.id, { expand: ["subscription"] });
      if (stripeInvoice.subscription) {
        subIdStr = typeof stripeInvoice.subscription === "string"
          ? stripeInvoice.subscription
          : stripeInvoice.subscription.id;
      }
    } catch (err) {
      console.error(`[webhook] invoice.paid: failed to retrieve invoice ${invoice.id} from Stripe:`, err);
    }
  }

  if (!subIdStr && invoice.customer) {
    console.log(`[webhook] invoice.paid: attempting customer-based subscription lookup for customer ${invoice.customer}`);
    try {
      const recentSubs = await requireStripe().subscriptions.list({
        customer: invoice.customer,
        limit: 5,
        status: "all",
        expand: ["data.latest_invoice"],
      });
      const matchingSub = recentSubs.data.find((s) => {
        const latestInv = s.latest_invoice;
        if (!latestInv) return false;
        const latestInvId = typeof latestInv === "string" ? latestInv : latestInv.id;
        return latestInvId === invoice.id;
      });
      if (matchingSub) {
        subIdStr = matchingSub.id;
        console.log(`[webhook] invoice.paid: found subscription ${subIdStr} via customer lookup`);
      }
    } catch (err) {
      console.error(`[webhook] invoice.paid: customer-based subscription lookup failed:`, err);
    }
  }

  if (!subIdStr) {
    console.log(`[webhook] invoice.paid: no subscription found for invoice ${invoice.id}, skipping (may be a one-time payment)`);
    return;
  }
  const isInitial = invoice.billing_reason === "subscription_create";
  const isProration = invoice.billing_reason === "subscription_update";

  if (isProration) {
    console.log(`[webhook] invoice.paid: skipping credit grant for proration/plan-change invoice ${invoice.id} (billing_reason=subscription_update)`);
    await pool.query(
      `UPDATE subscriptions SET status = 'active', updated_at = NOW()
       WHERE stripe_subscription_id = $1 AND status != 'active'`,
      [subIdStr]
    );
    return;
  }

  await pool.query(
    `UPDATE subscriptions SET status = 'active', updated_at = NOW()
     WHERE stripe_subscription_id = $1 AND status != 'active'`,
    [subIdStr]
  );

  let subResult = await pool.query(
    `SELECT user_id, plan_tier, credits_per_period, workspace_id FROM subscriptions WHERE stripe_subscription_id = $1`,
    [subIdStr]
  );

  if (subResult.rows.length === 0 && isInitial) {
    console.log(`[webhook] invoice.paid: subscription row not yet created for ${subIdStr}, fetching from Stripe`);
    try {
      const stripeSub = await requireStripe().subscriptions.retrieve(subIdStr, { expand: ["customer"] });
      const customerId = typeof stripeSub.customer === "string" ? stripeSub.customer : stripeSub.customer.id;
      const priceId = stripeSub.items.data[0]?.price?.id;
      const planTier = priceId ? resolvePlanTierFromPriceId(priceId) : null;

      if (!planTier) {
        const appUserId = (stripeSub as unknown as { metadata?: Record<string, string> }).metadata?.user_id;
        console.error(`[webhook] invoice.paid: cannot resolve plan tier for sub=${subIdStr} price=${priceId} user=${appUserId}`);
        throw new Error(`Cannot resolve plan tier for subscription ${subIdStr}`);
      }

      const planCfg = PLAN_CONFIG[planTier];
      const subMeta = (stripeSub as unknown as { metadata?: Record<string, string> }).metadata;
      const appUserId = subMeta?.user_id;
      const wsId = subMeta?.workspace_id || null;

      if (!appUserId) {
        console.error(`[webhook] invoice.paid: no user_id in subscription metadata for ${subIdStr}`);
        throw new Error(`No user_id in subscription metadata for ${subIdStr}`);
      }

      const stripeSubPeriod = getSubscriptionPeriod(stripeSub);
      console.log(`[webhook] invoice.paid: upserting subscription ${subIdStr} for user=${appUserId}, plan=${planTier}, period_start=${stripeSubPeriod.start}, period_end=${stripeSubPeriod.end}`);
      await upsertSubscriptionFromStripe(appUserId, subIdStr, customerId, planTier, planCfg, "active", wsId);

      subResult = await pool.query(
        `SELECT user_id, plan_tier, credits_per_period, workspace_id FROM subscriptions WHERE stripe_subscription_id = $1`,
        [subIdStr]
      );
    } catch (err) {
      console.error(`[webhook] invoice.paid: failed to resolve subscription ${subIdStr} from Stripe:`, err);
      throw err;
    }
  }

  if (subResult.rows.length === 0) {
    console.error("[webhook] invoice.paid: subscription not found:", subIdStr);
    throw new Error(`Subscription not found: ${subIdStr}`);
  }

  const sub = subResult.rows[0];

  if (isInitial) {
    const existingBackfill = await pool.query(
      `SELECT id FROM credit_ledger
       WHERE reference_id LIKE $1
         AND reason IN ('subscription:initial', 'subscription:backfill')
       LIMIT 1`,
      [`${subIdStr}:%`]
    );
    if (existingBackfill.rows.length > 0) {
      console.log(`[webhook] invoice.paid: credits already granted for subscription ${subIdStr} (prior backfill or initial grant), skipping`);
      return;
    }
  }

  const idempotencyKey = `${subIdStr}:${invoice.id}`;
  const reason = isInitial ? "subscription:initial" : "subscription:renewal";
  const creditMetadata = {
    type: isInitial ? "subscription_initial" : "subscription_renewal",
    plan_tier: sub.plan_tier,
    subscription_id: subIdStr,
    invoice_id: invoice.id,
    credits_granted: sub.credits_per_period,
    workspace_id: sub.workspace_id || undefined,
  };

  if (sub.workspace_id) {
    await grantWorkspaceCredits(sub.workspace_id, sub.credits_per_period, sub.user_id, reason, idempotencyKey, creditMetadata);
  } else {
    await grantCreditsAtomically(sub.user_id, sub.credits_per_period, reason, idempotencyKey, creditMetadata);
  }
}

function resolvePlanTierFromPriceId(priceId: string): string | null {
  for (const [tier, cfg] of Object.entries(PLAN_CONFIG)) {
    if (cfg.priceId === priceId) return tier;
  }
  return null;
}

async function handleSubscriptionUpdated(subscription: {
  id: string;
  status: string;
  current_period_start: number;
  current_period_end: number;
  metadata?: Record<string, string> | null;
  items?: { data?: Array<{ price?: { id?: string } }> };
}) {
  const statusMap: Record<string, string> = {
    active: "active",
    past_due: "past_due",
    canceled: "canceled",
    incomplete: "incomplete",
    incomplete_expired: "canceled",
    trialing: "active",
    unpaid: "past_due",
  };

  const mappedStatus = statusMap[subscription.status] || "incomplete";

  const initial = getSubscriptionPeriod(subscription);
  let periodStart = safeTimestampToDate(initial.start);
  let periodEnd = safeTimestampToDate(initial.end);

  if (!periodStart || !periodEnd) {
    try {
      const freshSub = await requireStripe().subscriptions.retrieve(subscription.id);
      const { start, end } = getSubscriptionPeriod(freshSub);
      periodStart = periodStart || safeTimestampToDate(start);
      periodEnd = periodEnd || safeTimestampToDate(end);
    } catch (err) {
      console.error(`[webhook] handleSubscriptionUpdated: failed to retrieve sub ${subscription.id} for period fallback:`, err);
    }
  }

  let planTier = subscription.metadata?.plan_tier || null;

  if (!planTier || !PLAN_CONFIG[planTier]) {
    const priceId = subscription.items?.data?.[0]?.price?.id;
    if (priceId) {
      planTier = resolvePlanTierFromPriceId(priceId);
    }
  }

  if (planTier && PLAN_CONFIG[planTier]) {
    await pool.query(
      `UPDATE subscriptions SET status = $1, plan_tier = $2, current_period_start = COALESCE($3, current_period_start), current_period_end = COALESCE($4, current_period_end),
       credits_per_period = $5, updated_at = NOW()
       WHERE stripe_subscription_id = $6`,
      [mappedStatus, planTier, periodStart, periodEnd, PLAN_CONFIG[planTier].creditsPerPeriod, subscription.id]
    );
  } else {
    await pool.query(
      `UPDATE subscriptions SET status = $1, current_period_start = COALESCE($2, current_period_start), current_period_end = COALESCE($3, current_period_end), updated_at = NOW()
       WHERE stripe_subscription_id = $4`,
      [mappedStatus, periodStart, periodEnd, subscription.id]
    );
  }
}

async function handleSubscriptionDeleted(subscription: { id: string }) {
  await pool.query(
    `UPDATE subscriptions SET status = 'canceled', updated_at = NOW()
     WHERE stripe_subscription_id = $1`,
    [subscription.id]
  );
}

router.get("/api/payments/verify-session", ensureStripeConfigured, async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.userId!;
    const sessionId = req.query.session_id as string;

    if (!sessionId || typeof sessionId !== "string") {
      res.status(400).json({ error: "Missing session_id query parameter" });
      return;
    }

    const session = await requireStripe().checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    if (session.mode === "subscription") {
      const metadata = session.metadata || {};

      if (!metadata.user_id) {
        console.error(`[verify-session] Subscription session ${sessionId} has no user_id in metadata`);
        res.status(400).json({ error: "Session metadata missing user_id" });
        return;
      }

      if (metadata.user_id !== userId) {
        console.error(`[verify-session] User ${userId} attempted to verify subscription session belonging to user ${metadata.user_id}`);
        res.status(403).json({ error: "Session does not belong to this user" });
        return;
      }

      if (session.payment_status !== "paid") {
        console.log(`[verify-session] Subscription session ${sessionId} payment_status is '${session.payment_status}', not 'paid'`);
        res.json({ status: "pending", payment_status: session.payment_status });
        return;
      }

      const subObj = session.subscription;
      if (!subObj) {
        console.log(`[verify-session] Subscription session ${sessionId} has no subscription object yet`);
        res.json({ status: "pending", payment_status: session.payment_status });
        return;
      }

      const subId = typeof subObj === "string" ? subObj : subObj.id;
      const planTier = metadata.plan_tier;
      const planCfg = planTier ? PLAN_CONFIG[planTier] : null;

      if (!planTier || !planCfg) {
        console.error(`[verify-session] Unknown plan_tier in subscription session: ${planTier}`);
        res.status(500).json({ error: "Unknown plan tier" });
        return;
      }

      const workspaceId = metadata.workspace_id || null;
      const customerId = typeof session.customer === "string" ? session.customer : null;

      await upsertSubscriptionFromStripe(userId, subId, customerId, planTier, planCfg, "active", workspaceId);

      const existingCredit = await pool.query(
        `SELECT id FROM credit_ledger
         WHERE reference_id LIKE $1
           AND reason IN ('subscription:initial', 'subscription:backfill')
         LIMIT 1`,
        [`${subId}:%`]
      );

      let creditsGranted = planCfg.creditsPerPeriod;
      if (existingCredit.rows.length === 0) {
        const sub = await pool.query(
          `SELECT user_id, workspace_id, credits_per_period FROM subscriptions WHERE stripe_subscription_id = $1`,
          [subId]
        );
        if (sub.rows.length > 0) {
          const subRow = sub.rows[0];
          creditsGranted = subRow.credits_per_period;

          let invoiceId: string | null = null;
          try {
            const stripeSub = await requireStripe().subscriptions.retrieve(subId, { expand: ["latest_invoice"] });
            const latestInv = (stripeSub as unknown as { latest_invoice?: string | { id: string } | null }).latest_invoice;
            if (latestInv) {
              invoiceId = typeof latestInv === "string" ? latestInv : latestInv.id;
            }
          } catch (invoiceErr) {
            console.warn(`[verify-session] Could not retrieve latest invoice for sub=${subId}:`, invoiceErr);
          }

          if (!invoiceId) {
            console.log(`[verify-session] Invoice ID not yet available for sub=${subId} — deferring credit grant to webhook`);
          } else {
            const idempotencyKey = `${subId}:${invoiceId}`;
            const creditMetadata = {
              type: "subscription_initial",
              plan_tier: planTier,
              subscription_id: subId,
              session_id: sessionId,
              invoice_id: invoiceId,
              credits_granted: creditsGranted,
              workspace_id: subRow.workspace_id || undefined,
            };

            if (subRow.workspace_id) {
              await grantWorkspaceCredits(subRow.workspace_id, creditsGranted, userId, "subscription:initial", idempotencyKey, creditMetadata);
            } else {
              await grantCreditsAtomically(userId, creditsGranted, "subscription:initial", idempotencyKey, creditMetadata);
            }
            console.log(`[verify-session] Granted ${creditsGranted} subscription credits for user=${userId}, session=${sessionId}, sub=${subId}, key=${idempotencyKey}`);
          }
        }
      } else {
        console.log(`[verify-session] Subscription credits already granted for sub=${subId}`);
      }

      res.json({ status: "completed", credits: creditsGranted });
      return;
    }

    const purchaseResult = await pool.query(
      `SELECT id, status, credits_granted, workspace_id FROM purchases
       WHERE stripe_session_id = $1 AND user_id = $2`,
      [sessionId, userId]
    );

    if (purchaseResult.rows.length === 0) {
      res.status(404).json({ error: "Purchase not found" });
      return;
    }

    const purchase = purchaseResult.rows[0];

    if (purchase.status === "completed") {
      res.json({ status: "completed", credits: purchase.credits_granted });
      return;
    }

    if (session.payment_status !== "paid") {
      console.log(`[verify-session] Session ${sessionId} payment_status is '${session.payment_status}', not 'paid'`);
      res.json({ status: "pending", payment_status: session.payment_status });
      return;
    }

    const metadata = session.metadata || {};
    const credits = parseInt(metadata.credits || "0", 10) || purchase.credits_granted;

    if (credits <= 0) {
      console.error(`[verify-session] Invalid credits for session=${sessionId}: metadata=${metadata.credits}, db=${purchase.credits_granted}`);
      res.status(500).json({ error: "Invalid credit amount in session" });
      return;
    }

    const workspaceId = metadata.workspace_id || purchase.workspace_id || null;
    const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;

    await grantPurchaseCreditsAtomically(userId, credits, sessionId, paymentIntentId, workspaceId);
    console.log(`[verify-session] Granted ${credits} credits for user=${userId}, session=${sessionId} (fallback verification)`);

    res.json({ status: "completed", credits });
  } catch (err) {
    console.error("[verify-session] Error verifying session:", err);
    res.status(500).json({ error: "Failed to verify session" });
  }
});

export async function handleStripeWebhook(req: Request, res: Response) {
  console.log("[webhook] Incoming Stripe webhook request received");
  const sig = req.headers["stripe-signature"];

  if (!sig) {
    console.error("[webhook] Missing stripe-signature header");
    res.status(400).json({ error: "Missing stripe-signature header" });
    return;
  }

  let webhookSecret: string;
  try {
    webhookSecret = requireWebhookSecret();
  } catch {
    console.error("[webhook] STRIPE_WEBHOOK_SECRET not configured — rejecting webhook");
    res.status(503).json({ error: "Webhook processing is not configured" });
    return;
  }

  let event;
  try {
    event = requireStripe().webhooks.constructEvent(
      req.body,
      Array.isArray(sig) ? sig[0] : sig,
      webhookSecret
    );
    console.log(`[webhook] Signature verified successfully, event type: ${event.type}, event id: ${event.id}`);
  } catch (err) {
    console.error("[webhook] Signature verification failed:", (err as Error).message);
    res.status(400).json({ error: "Webhook signature verification failed" });
    return;
  }

  try {
    switch (event.type) {
      case "checkout.session.completed":
        console.log(`[webhook] Processing checkout.session.completed, session id: ${(event.data.object as { id: string }).id}`);
        await handleCheckoutCompleted(event.data.object as Parameters<typeof handleCheckoutCompleted>[0]);
        console.log(`[webhook] Successfully processed checkout.session.completed`);
        break;
      case "invoice.paid":
        console.log(`[webhook] Processing invoice.paid, invoice id: ${(event.data.object as { id: string }).id}`);
        await handleInvoicePaid(event.data.object as Parameters<typeof handleInvoicePaid>[0]);
        console.log(`[webhook] Successfully processed invoice.paid`);
        break;
      case "customer.subscription.updated":
        console.log(`[webhook] Processing customer.subscription.updated, subscription id: ${(event.data.object as { id: string }).id}`);
        await handleSubscriptionUpdated(event.data.object as Parameters<typeof handleSubscriptionUpdated>[0]);
        console.log(`[webhook] Successfully processed customer.subscription.updated`);
        break;
      case "customer.subscription.created": {
        const createdSub = event.data.object as { id: string; customer?: string | { id: string }; metadata?: Record<string, string>; items?: { data: Array<{ price?: { id: string } }> }; status?: string; current_period_start?: number; current_period_end?: number };
        console.log(`[webhook] Processing customer.subscription.created, subscription id: ${createdSub.id}, status: ${createdSub.status}`);
        const subMeta = createdSub.metadata || {};
        const appUserId = subMeta.user_id;
        const wsId = subMeta.workspace_id || null;
        const customerId = createdSub.customer
          ? (typeof createdSub.customer === "string" ? createdSub.customer : createdSub.customer.id)
          : null;
        const priceId = createdSub.items?.data[0]?.price?.id;
        const planTier = priceId ? resolvePlanTierFromPriceId(priceId) : null;

        if (appUserId && planTier && PLAN_CONFIG[planTier]) {
          const planCfg = PLAN_CONFIG[planTier];
          const initialStatus = createdSub.status === "active" ? "active" as const : "incomplete" as const;
          const createdPeriod = getSubscriptionPeriod(createdSub);
          const eventPeriodStart = safeTimestampToDate(createdPeriod.start);
          const eventPeriodEnd = safeTimestampToDate(createdPeriod.end);
          await upsertSubscriptionFromStripe(appUserId, createdSub.id, customerId, planTier, planCfg, initialStatus, wsId, eventPeriodStart, eventPeriodEnd);
          console.log(`[webhook] Successfully upserted subscription from customer.subscription.created: sub=${createdSub.id}, user=${appUserId}, plan=${planTier}, status=${initialStatus}`);
        } else {
          console.warn(`[webhook] customer.subscription.created: missing data to upsert - user_id=${appUserId}, planTier=${planTier}, sub=${createdSub.id}`);
        }
        break;
      }
      case "customer.subscription.deleted":
        console.log(`[webhook] Processing customer.subscription.deleted, subscription id: ${(event.data.object as { id: string }).id}`);
        await handleSubscriptionDeleted(event.data.object as Parameters<typeof handleSubscriptionDeleted>[0]);
        console.log(`[webhook] Successfully processed customer.subscription.deleted`);
        break;
      default:
        console.log(`[webhook] Unhandled event type: ${event.type}`);
    }

    res.json({ received: true });
  } catch (err) {
    console.error(`[webhook] Error handling ${event.type}:`, err);
    res.status(500).json({ error: "Webhook processing failed" });
  }
}

export async function backfillPendingPurchases(): Promise<void> {
  if (!isStripeConfigured()) {
    console.log("[backfill] Stripe not configured, skipping pending purchase backfill");
    return;
  }

  try {
    const pendingResult = await pool.query(
      `SELECT id, user_id, stripe_session_id, credits_granted, workspace_id
       FROM purchases
       WHERE status = 'pending' AND created_at < NOW() - INTERVAL '10 minutes'`
    );

    if (pendingResult.rows.length === 0) {
      console.log("[backfill] No stale pending purchases found");
      return;
    }

    console.log(`[backfill] Found ${pendingResult.rows.length} stale pending purchase(s), checking with Stripe...`);

    for (const purchase of pendingResult.rows) {
      try {
        const session = await requireStripe().checkout.sessions.retrieve(purchase.stripe_session_id);

        if (session.payment_status === "paid") {
          const metadata = session.metadata || {};
          const credits = parseInt(metadata.credits || "0", 10) || purchase.credits_granted;
          const workspaceId = metadata.workspace_id || purchase.workspace_id || null;
          const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : null;

          await grantPurchaseCreditsAtomically(purchase.user_id, credits, purchase.stripe_session_id, paymentIntentId, workspaceId);
          console.log(`[backfill] Granted ${credits} credits for user=${purchase.user_id}, session=${purchase.stripe_session_id}`);
        } else {
          console.log(`[backfill] Session ${purchase.stripe_session_id} payment_status='${session.payment_status}', skipping`);
        }
      } catch (err) {
        console.error(`[backfill] Error processing purchase id=${purchase.id}, session=${purchase.stripe_session_id}:`, err);
      }
    }

    console.log("[backfill] Pending purchase backfill complete");
  } catch (err) {
    console.error("[backfill] Error during pending purchase backfill:", err);
  }
}

export async function backfillSpecificUser(
  userId: string,
  stripeCustomerId: string,
  checkoutSessionId: string
): Promise<boolean> {
  if (!isStripeConfigured()) {
    console.log("[backfill-user] Stripe not configured, skipping");
    return false;
  }

  const existingSub = await pool.query(
    `SELECT id FROM subscriptions WHERE user_id = $1 AND status = 'active'`,
    [userId]
  );
  if (existingSub.rows.length > 0) {
    console.log(`[backfill-user] User ${userId} already has an active subscription, already done`);
    return true;
  }

  const session = await requireStripe().checkout.sessions.retrieve(checkoutSessionId, { expand: ["subscription"] });
  const subId = typeof session.subscription === "string"
    ? session.subscription
    : (session.subscription as unknown as { id: string } | null)?.id;

  if (!subId) {
    throw new Error(`[backfill-user] No subscription found on checkout session ${checkoutSessionId}`);
  }

  const stripeSub = await requireStripe().subscriptions.retrieve(subId);
  const priceId = stripeSub.items.data[0]?.price?.id;
  const planTier = priceId ? resolvePlanTierFromPriceId(priceId) : null;

  if (!planTier || !PLAN_CONFIG[planTier]) {
    throw new Error(`[backfill-user] Cannot resolve plan tier for sub=${subId}, price=${priceId}`);
  }

  const planCfg = PLAN_CONFIG[planTier];
  const subMeta = (stripeSub as unknown as { metadata?: Record<string, string> }).metadata;
  const wsId = subMeta?.workspace_id || null;

  console.log(`[backfill-user] Creating subscription record: sub=${subId}, user=${userId}, plan=${planTier}`);
  await upsertSubscriptionFromStripe(userId, subId, stripeCustomerId, planTier, planCfg, "active", wsId);

  const idempotencyKey = `${subId}:backfill-${userId}`;
  const creditMetadata = {
    type: "subscription_backfill",
    plan_tier: planTier,
    subscription_id: subId,
    checkout_session_id: checkoutSessionId,
    credits_granted: planCfg.creditsPerPeriod,
    workspace_id: wsId || undefined,
  };

  if (wsId) {
    await grantWorkspaceCredits(wsId, planCfg.creditsPerPeriod, userId, "subscription:backfill", idempotencyKey, creditMetadata);
  } else {
    await grantCreditsAtomically(userId, planCfg.creditsPerPeriod, "subscription:backfill", idempotencyKey, creditMetadata);
  }
  console.log(`[backfill-user] Granted ${planCfg.creditsPerPeriod} credits for user=${userId}, sub=${subId}${wsId ? `, workspace=${wsId}` : ""}`);

  const verifyResult = await pool.query(
    `SELECT id FROM subscriptions WHERE user_id = $1 AND stripe_customer_id = $2 AND status = 'active'`,
    [userId, stripeCustomerId]
  );
  if (verifyResult.rows.length === 0) {
    throw new Error(`[backfill-user] Post-condition failed: no active subscription found for user ${userId}`);
  }

  return true;
}

export async function backfillMissingSubscriptions(): Promise<void> {
  if (!isStripeConfigured()) {
    console.log("[backfill] Stripe not configured, skipping subscription backfill");
    return;
  }

  try {
    const usersWithCustomerId = await pool.query(
      `SELECT DISTINCT u.id AS user_id, u.stripe_customer_id
       FROM users u
       WHERE u.stripe_customer_id IS NOT NULL
         AND u.stripe_customer_id != ''`
    );

    if (usersWithCustomerId.rows.length === 0) {
      console.log("[backfill] No users with Stripe customer IDs found");
      return;
    }

    console.log(`[backfill] Checking ${usersWithCustomerId.rows.length} user(s) for missing active subscriptions...`);
    let reconciledCount = 0;

    for (const row of usersWithCustomerId.rows) {
      try {
        const stripeSubscriptions = await requireStripe().subscriptions.list({
          customer: row.stripe_customer_id,
          status: "active",
          limit: 10,
        });

        for (const stripeSub of stripeSubscriptions.data) {
          const existingRow = await pool.query(
            `SELECT id, status, current_period_start, current_period_end FROM subscriptions WHERE stripe_subscription_id = $1`,
            [stripeSub.id]
          );

          const isStuckIncomplete = existingRow.rows.length > 0 && existingRow.rows[0].status !== "active";
          if (isStuckIncomplete) {
            console.log(`[backfill] Found subscription ${stripeSub.id} stuck at '${existingRow.rows[0].status}' but active in Stripe, updating...`);
            await pool.query(
              `UPDATE subscriptions SET status = 'active', updated_at = NOW() WHERE stripe_subscription_id = $1`,
              [stripeSub.id]
            );
          }

          const priceId = stripeSub.items.data[0]?.price?.id;
          const planTier = priceId ? resolvePlanTierFromPriceId(priceId) : null;

          if (!planTier || !PLAN_CONFIG[planTier]) {
            console.warn(`[backfill] Cannot resolve plan tier for sub=${stripeSub.id}, price=${priceId}, skipping`);
            continue;
          }

          const planCfg = PLAN_CONFIG[planTier];
          const subMeta = (stripeSub as unknown as { metadata?: Record<string, string> }).metadata;
          const appUserId = subMeta?.user_id || row.user_id;
          const wsId = subMeta?.workspace_id || null;

          const existingCredit = await pool.query(
            `SELECT id FROM credit_ledger
             WHERE reference_id LIKE $1
               AND reason IN ('subscription:initial', 'subscription:backfill')`,
            [`${stripeSub.id}:%`]
          );

          if (existingCredit.rows.length > 0) {
            if (existingRow.rows.length > 0 && existingRow.rows[0].status === "active") {
              if (existingRow.rows[0].current_period_start && existingRow.rows[0].current_period_end) {
                continue;
              }
              console.log(`[backfill] Active subscription ${stripeSub.id} has credits but missing period dates, backfilling...`);
            } else {
              console.log(`[backfill] Credits already granted for sub=${stripeSub.id}, inserting subscription row only`);
            }
            await upsertSubscriptionFromStripe(appUserId, stripeSub.id, row.stripe_customer_id, planTier, planCfg, "active", wsId);
            reconciledCount++;
            continue;
          }

          if (existingRow.rows.length > 0 && existingRow.rows[0].status === "active") {
            console.log(`[backfill] Active subscription ${stripeSub.id} is missing credit grant, granting ${planCfg.creditsPerPeriod} credits...`);
          } else {
            console.log(`[backfill] Reconciling missing subscription: sub=${stripeSub.id}, user=${appUserId}, plan=${planTier}`);
          }

          await upsertSubscriptionFromStripe(appUserId, stripeSub.id, row.stripe_customer_id, planTier, planCfg, "active", wsId);

          const idempotencyKey = `${stripeSub.id}:backfill`;
          const creditMetadata = {
            type: "subscription_backfill",
            plan_tier: planTier,
            subscription_id: stripeSub.id,
            credits_granted: planCfg.creditsPerPeriod,
            workspace_id: wsId || undefined,
          };

          if (wsId) {
            await grantWorkspaceCredits(wsId, planCfg.creditsPerPeriod, appUserId, "subscription:backfill", idempotencyKey, creditMetadata);
          } else {
            await grantCreditsAtomically(appUserId, planCfg.creditsPerPeriod, "subscription:backfill", idempotencyKey, creditMetadata);
          }

          console.log(`[backfill] Granted ${planCfg.creditsPerPeriod} credits for backfilled subscription ${stripeSub.id}`);
          reconciledCount++;
        }
      } catch (err) {
        console.error(`[backfill] Error checking subscriptions for customer=${row.stripe_customer_id}:`, err);
      }
    }

    console.log(`[backfill] Subscription backfill complete, reconciled ${reconciledCount} subscription(s)`);
  } catch (err) {
    console.error("[backfill] Error during subscription backfill:", err);
  }
}

export default router;
