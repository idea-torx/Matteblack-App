import { pool } from "../db.js";
import { createNotification } from "../notifications.js";
import { sendLowBalanceEmail } from "./lowBalanceEmail.js";
import { AGENT_MARGIN_MULTIPLIER, CREDITS_PER_DOLLAR } from "../stripe.js";

export type DebitResult = {
  success: true;
  cost: number;
  newBalance: number;
  ledgerId: string;
} | {
  success: false;
  error: string;
  required?: number;
  balance?: number;
  retryAfterSeconds?: number;
};

export type PricingParams = {
  modelKey?: string;
  resolution?: string;
  duration?: string | number;
  features?: string[];
  characters?: number;
  inputTokens?: number;
  outputTokens?: number;
};

export type CostBreakdown = {
  model: string | null;
  pricingSource: "model" | "tokens";
  baseCost: number;
  resolutionMultiplier: number;
  durationMultiplier: number;
  characters?: number;
  characterMultiplier?: number;
  featureSurcharges: Record<string, number>;
  flatFeatureSurcharges?: Record<string, number>;
  quantity: number;
  totalCost: number;
  inputTokens?: number;
  outputTokens?: number;
  inputRate?: number;
  outputRate?: number;
  netDollars?: number;
  marginMultiplier?: number;
};

export async function calculateModelCost(
  generationType: string,
  quantity: number,
  pricing?: PricingParams
): Promise<{ totalCost: number; breakdown: CostBreakdown } | { error: string }> {
  const safeQuantity = Math.floor(quantity);
  if (safeQuantity < 1 || safeQuantity > 100) {
    return { error: `Invalid quantity: must be between 1 and 100` };
  }

  let baseCost: number;
  let resolutionMultiplier = 1;
  let durationMultiplier = 1;
  const featureSurchargeMap: Record<string, number> = {};
  const flatFeatureSurchargeMap: Record<string, number> = {};
  let modelUsed: string | null = null;
  let pricingSource: "model" | "tokens" = "model";

  // Token-based billing path. When the model row carries non-zero per-1M-token
  // rates AND the caller supplies token counts, bill by tokens with a 25%
  // platform margin and short-circuit the rest of the cost calculation. This
  // is what the Sonnet agent runs through; other models with both columns
  // still defaulting to 0 fall through to the legacy base/multiplier math.
  if (pricing?.modelKey && (typeof pricing.inputTokens === "number" || typeof pricing.outputTokens === "number")) {
    const tokenRow = await pool.query(
      `SELECT input_token_net_cost_per_million, output_token_net_cost_per_million, is_active
         FROM model_pricing WHERE model_key = $1`,
      [pricing.modelKey]
    );
    if (tokenRow.rows.length > 0 && tokenRow.rows[0].is_active) {
      const inRate = Number(tokenRow.rows[0].input_token_net_cost_per_million) || 0;
      const outRate = Number(tokenRow.rows[0].output_token_net_cost_per_million) || 0;
      if (inRate > 0 || outRate > 0) {
        const inTok = Math.max(0, Math.floor(pricing.inputTokens ?? 0));
        const outTok = Math.max(0, Math.floor(pricing.outputTokens ?? 0));
        const netDollars = (inTok * inRate + outTok * outRate) / 1_000_000;
        const totalCostRaw = netDollars * AGENT_MARGIN_MULTIPLIER * CREDITS_PER_DOLLAR * safeQuantity;
        const totalCost = totalCostRaw > 0 ? Math.max(1, Math.ceil(totalCostRaw)) : 0;
        const breakdown: CostBreakdown = {
          model: pricing.modelKey,
          pricingSource: "tokens",
          baseCost: 0,
          resolutionMultiplier: 1,
          durationMultiplier: 1,
          featureSurcharges: {},
          quantity: safeQuantity,
          totalCost,
          inputTokens: inTok,
          outputTokens: outTok,
          inputRate: inRate,
          outputRate: outRate,
          netDollars,
          marginMultiplier: AGENT_MARGIN_MULTIPLIER,
        };
        return { totalCost, breakdown };
      }
    }
  }

  let usedModelPricing = false;
  if (pricing?.modelKey) {
    const modelResult = await pool.query(
      `SELECT base_cost, resolution_multipliers, duration_multipliers, feature_surcharges, is_active
       FROM model_pricing WHERE model_key = $1`,
      [pricing.modelKey]
    );

    if (modelResult.rows.length > 0 && modelResult.rows[0].is_active) {
      usedModelPricing = true;
      const mp = modelResult.rows[0];
      baseCost = mp.base_cost;
      modelUsed = pricing.modelKey;
      pricingSource = "model";

      if (pricing.resolution && mp.resolution_multipliers) {
        const key = (pricing.resolution as string).toLowerCase();
        const mult = mp.resolution_multipliers[key];
        if (typeof mult === "number") {
          resolutionMultiplier = mult;
        }
      }

      if (mp.duration_multipliers?.per_1000_characters && typeof pricing.characters === "number" && pricing.characters > 0) {
        const charBlocks = Math.ceil(pricing.characters / 1000);
        durationMultiplier = charBlocks * mp.duration_multipliers.per_1000_characters;
      } else if (pricing.duration && mp.duration_multipliers) {
        const durStr = String(pricing.duration);
        if (mp.duration_multipliers.per_minute) {
          const seconds = parseFloat(durStr);
          if (!isNaN(seconds) && seconds > 0) {
            const minutes = Math.ceil(seconds / 60);
            durationMultiplier = minutes * mp.duration_multipliers.per_minute;
          }
        } else if (mp.duration_multipliers.per_second) {
          const seconds = parseFloat(durStr);
          if (!isNaN(seconds) && seconds > 0) {
            durationMultiplier = seconds * mp.duration_multipliers.per_second;
          }
        } else {
          const mult = mp.duration_multipliers[durStr];
          if (typeof mult === "number") {
            durationMultiplier = mult;
          }
        }
      }

      if (pricing.features && Array.isArray(pricing.features) && mp.feature_surcharges) {
        for (const feat of pricing.features) {
          const surcharge = mp.feature_surcharges[feat];
          if (typeof surcharge === "number") {
            featureSurchargeMap[feat] = surcharge;
          } else if (
            surcharge !== null &&
            typeof surcharge === "object" &&
            "flat" in surcharge &&
            typeof surcharge.flat === "number"
          ) {
            // Flat surcharges are NOT multiplied by duration / resolution — they
            // represent a one-time per-generation fee from the upstream provider
            // (e.g. Kling O3 Pro audio = +18 cr regardless of clip length).
            flatFeatureSurchargeMap[feat] = surcharge.flat;
          }
        }
      }
    }
  }

  if (!usedModelPricing) {
    return { error: `No active model pricing found for this generation. Please configure model pricing for the selected model.` };
  }

  const surchargeTotal = Object.values(featureSurchargeMap).reduce((s, v) => s + v, 0);
  const flatSurchargeTotal = Object.values(flatFeatureSurchargeMap).reduce((s, v) => s + v, 0);
  const rawCost = Math.round(
    (baseCost + surchargeTotal) * resolutionMultiplier * durationMultiplier * safeQuantity
      + flatSurchargeTotal * safeQuantity
  );
  const hasCharacterPricing = typeof pricing?.characters === "number" && pricing.characters > 0;
  const totalCost = hasCharacterPricing ? Math.max(1, rawCost) : Math.max(0, rawCost);

  const breakdown: CostBreakdown = {
    model: modelUsed,
    pricingSource,
    baseCost,
    resolutionMultiplier,
    durationMultiplier,
    featureSurcharges: featureSurchargeMap,
    quantity: safeQuantity,
    totalCost,
  };

  if (Object.keys(flatFeatureSurchargeMap).length > 0) {
    breakdown.flatFeatureSurcharges = flatFeatureSurchargeMap;
  }

  if (typeof pricing?.characters === "number" && pricing.characters > 0) {
    breakdown.characters = pricing.characters;
    breakdown.characterMultiplier = Math.ceil(pricing.characters / 1000);
  }

  return {
    totalCost,
    breakdown,
  };
}

async function resolveWorkspaceForUser(userId: string, orgId?: string, client?: { query: typeof pool.query }): Promise<{ workspaceId: string; isOrg: boolean } | null> {
  if (!orgId) return null;
  const q = client ?? pool;
  const wsResult = await q.query(
    `SELECT w.id, w.type FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE w.id = $1 AND wm.user_id = $2 AND w.type = 'org'`,
    [orgId, userId]
  );
  if (wsResult.rows.length > 0) {
    return { workspaceId: wsResult.rows[0].id, isOrg: true };
  }
  return null;
}

export async function checkAndDebit(
  userId: string,
  generationType: string,
  quantity: number = 1,
  referenceId?: string,
  orgId?: string,
  pricing?: PricingParams
): Promise<DebitResult> {
  const safeQuantity = Math.floor(quantity);
  if (safeQuantity < 1 || safeQuantity > 100) {
    return { success: false, error: `Invalid quantity: must be between 1 and 100` };
  }

  const userResult = await pool.query(
    `SELECT role FROM users WHERE id = $1`,
    [userId]
  );
  const role = userResult.rows.length > 0 ? userResult.rows[0].role : "user";
  const isSuperAdmin = role === "superadmin";

  if (isSuperAdmin) {
    return { success: true, cost: 0, newBalance: 0, ledgerId: "" };
  }

  const costResult = await calculateModelCost(generationType, safeQuantity, pricing);
  if ("error" in costResult) {
    return { success: false, error: costResult.error };
  }

  const { totalCost, breakdown } = costResult;

  if (totalCost < 0) {
    return { success: false, error: "Invalid cost calculation" };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const wsInfo = await resolveWorkspaceForUser(userId, orgId, client);
    const useWorkspaceCredits = wsInfo !== null && wsInfo.isOrg;

    const userIdNumeric = Buffer.from(userId.replace(/-/g, ""), "hex").readBigInt64BE(0);
    await client.query(`SELECT pg_advisory_xact_lock($1)`, [String(userIdNumeric)]);

    const rateResult = await client.query(
      `SELECT max_requests, window_seconds FROM rate_limits WHERE generation_type = $1`,
      [generationType]
    );

    if (rateResult.rows.length > 0) {
      const { max_requests, window_seconds } = rateResult.rows[0];
      const recentCount = await client.query(
        `SELECT COUNT(*) AS cnt,
                MIN(created_at) AS oldest
         FROM credit_ledger
         WHERE user_id = $1
           AND reason LIKE $2
           AND created_at > NOW() - ($3 || ' seconds')::INTERVAL`,
        [userId, `generation:${generationType}%`, String(window_seconds)]
      );

      const count = parseInt(recentCount.rows[0].cnt, 10);
      if (count >= max_requests) {
        await client.query("ROLLBACK");
        const oldestInWindow = recentCount.rows[0].oldest;
        const oldestTime = new Date(oldestInWindow).getTime();
        const windowEnd = oldestTime + window_seconds * 1000;
        const retryAfter = Math.max(1, Math.ceil((windowEnd - Date.now()) / 1000));
        return {
          success: false,
          error: `Rate limit exceeded. Try again in ${retryAfter} seconds.`,
          retryAfterSeconds: retryAfter,
        };
      }
    }

    let newBalance: number;

    if (useWorkspaceCredits) {
      if (totalCost > 0) {
        const deducted = await client.query(
          `UPDATE workspace_credits SET balance = balance - $2, updated_at = NOW()
           WHERE workspace_id = $1 AND balance >= $2
           RETURNING balance`,
          [wsInfo.workspaceId, totalCost]
        );

        if (deducted.rows.length === 0) {
          await client.query("ROLLBACK");
          const creditResult = await pool.query(
            `SELECT balance FROM workspace_credits WHERE workspace_id = $1`,
            [wsInfo.workspaceId]
          );
          const balance = creditResult.rows.length > 0 ? creditResult.rows[0].balance : 0;
          return {
            success: false,
            error: "Insufficient workspace credits",
            required: totalCost,
            balance,
          };
        }
        newBalance = deducted.rows[0].balance;
      } else {
        const balResult = await client.query(
          `SELECT balance FROM workspace_credits WHERE workspace_id = $1`,
          [wsInfo.workspaceId]
        );
        newBalance = balResult.rows.length > 0 ? balResult.rows[0].balance : 0;
      }
    } else {
      if (totalCost > 0) {
        const deducted = await client.query(
          `UPDATE credits SET balance = balance - $2, updated_at = NOW()
           WHERE user_id = $1 AND balance >= $2
           RETURNING balance`,
          [userId, totalCost]
        );

        if (deducted.rows.length === 0) {
          await client.query("ROLLBACK");
          const creditResult = await pool.query(
            `SELECT balance FROM credits WHERE user_id = $1`,
            [userId]
          );
          const balance = creditResult.rows.length > 0 ? creditResult.rows[0].balance : 0;
          return {
            success: false,
            error: "Insufficient credits",
            required: totalCost,
            balance,
          };
        }
        newBalance = deducted.rows[0].balance;
      } else {
        const balResult = await client.query(
          `SELECT balance FROM credits WHERE user_id = $1`,
          [userId]
        );
        newBalance = balResult.rows.length > 0 ? balResult.rows[0].balance : 0;
      }
    }

    const ledgerResult = await client.query(
      `INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason, reference_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        userId,
        useWorkspaceCredits ? wsInfo.workspaceId : null,
        -totalCost,
        newBalance,
        `generation:${generationType}`,
        referenceId || null,
        JSON.stringify({ ...breakdown, workspace_billing: useWorkspaceCredits }),
      ]
    );

    await client.query("COMMIT");

    if (totalCost > 0) {
      if (useWorkspaceCredits) {
        handleWorkspacePostDebitAlerts(wsInfo.workspaceId, newBalance, totalCost, generationType).catch(
          (err) => console.error("[creditGate] workspace post-debit alert error:", err)
        );
      } else {
        handlePostDebitAlerts(userId, newBalance, totalCost, generationType).catch(
          (err) => console.error("[creditGate] post-debit alert error:", err)
        );
      }
    }

    return {
      success: true,
      cost: totalCost,
      newBalance,
      ledgerId: ledgerResult.rows[0].id,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function persistPendingRefund(
  userId: string,
  amount: number,
  reason: string,
  referenceId?: string,
  orgId?: string,
  errorMsg?: string
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO pending_refunds (user_id, amount, reason, reference_id, org_id, last_error)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, amount, reason, referenceId || null, orgId || null, errorMsg || null]
    );
    console.warn(`[creditGate] Persisted pending refund for user=${userId} amount=${amount} reason=${reason} ref=${referenceId || "none"}`);
  } catch (persistErr) {
    console.error("[creditGate] CRITICAL: Failed to persist pending refund:", persistErr, { userId, amount, reason, referenceId });
  }
}

export async function refundCreditsWithFallback(
  userId: string,
  amount: number,
  reason: string,
  referenceId?: string,
  orgId?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  try {
    await refundCredits(userId, amount, reason, referenceId, orgId, metadata);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[creditGate] refund failed, persisting to pending_refunds: user=${userId} amount=${amount} reason=${reason}`, err);
    await persistPendingRefund(userId, amount, reason, referenceId, orgId, errorMsg);
  }
}

export async function retryPendingRefunds(): Promise<void> {
  let pending;
  try {
    pending = await pool.query(
      `SELECT id, user_id, amount, reason, reference_id, org_id, retry_count
       FROM pending_refunds
       WHERE retry_count < 10
       ORDER BY created_at ASC
       LIMIT 50`
    );
  } catch (err) {
    console.error("[creditGate] retryPendingRefunds: failed to query pending_refunds:", err);
    return;
  }

  if (pending.rows.length === 0) return;
  console.log(`[creditGate] Retrying ${pending.rows.length} pending refund(s)`);

  for (const row of pending.rows) {
    try {
      await refundCredits(row.user_id, row.amount, row.reason, row.reference_id || undefined, row.org_id || undefined);
      await pool.query(`DELETE FROM pending_refunds WHERE id = $1`, [row.id]);
      console.log(`[creditGate] Retried pending refund id=${row.id} for user=${row.user_id}`);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[creditGate] Retry failed for pending refund id=${row.id}:`, err);
      await pool.query(
        `UPDATE pending_refunds SET retry_count = retry_count + 1, last_error = $1, updated_at = NOW() WHERE id = $2`,
        [errorMsg, row.id]
      ).catch((updateErr) => console.error("[creditGate] Failed to update retry count:", updateErr));
    }
  }
}

export async function refundCredits(
  userId: string,
  amount: number,
  reason: string,
  referenceId?: string,
  orgId?: string,
  metadata?: Record<string, unknown>
): Promise<{ newBalance: number }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const wsInfo = await resolveWorkspaceForUser(userId, orgId, client);
    const useWorkspaceCredits = wsInfo !== null && wsInfo.isOrg;

    let newBalance: number;

    if (useWorkspaceCredits) {
      const updated = await client.query(
        `UPDATE workspace_credits SET balance = balance + $2, updated_at = NOW()
         WHERE workspace_id = $1
         RETURNING balance`,
        [wsInfo.workspaceId, amount]
      );
      if (updated.rows.length === 0) {
        await client.query(
          `INSERT INTO workspace_credits (workspace_id, balance) VALUES ($1, $2)
           ON CONFLICT (workspace_id) DO UPDATE SET balance = workspace_credits.balance + $2, updated_at = NOW()`,
          [wsInfo.workspaceId, amount]
        );
        const bal = await client.query(`SELECT balance FROM workspace_credits WHERE workspace_id = $1`, [wsInfo.workspaceId]);
        newBalance = bal.rows[0].balance;
      } else {
        newBalance = updated.rows[0].balance;
      }
    } else {
      const updated = await client.query(
        `UPDATE credits SET balance = balance + $2, updated_at = NOW()
         WHERE user_id = $1
         RETURNING balance`,
        [userId, amount]
      );
      newBalance = updated.rows.length > 0 ? updated.rows[0].balance : amount;
    }

    await client.query(
      `INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason, reference_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        userId,
        useWorkspaceCredits ? wsInfo.workspaceId : null,
        amount,
        newBalance,
        `refund:${reason}`,
        referenceId || null,
        metadata ? JSON.stringify({ ...metadata, workspace_billing: useWorkspaceCredits }) : null,
      ]
    );

    await client.query("COMMIT");

    return { newBalance };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}


async function handlePostDebitAlerts(
  userId: string,
  newBalance: number,
  cost: number,
  generationType: string
): Promise<void> {
  const typeLabel = generationType.replace(/_/g, " ");
  createNotification({
    userId,
    type: "credits_used",
    title: "Credits used",
    message: `${cost} credits used for ${typeLabel}. Balance: ${newBalance} credits.`,
    severity: "info",
    metadata: { cost, balance: newBalance, job_type: generationType },
  });

  const thresholds = await getAlertThresholds();

  for (const threshold of thresholds) {
    if (newBalance <= threshold && newBalance + cost > threshold) {
      const existing = await pool.query(
        `SELECT 1 FROM low_balance_alerts WHERE user_id = $1 AND threshold = $2`,
        [userId, threshold]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO low_balance_alerts (user_id, threshold)
           VALUES ($1, $2)
           ON CONFLICT (user_id, threshold) DO NOTHING`,
          [userId, threshold]
        );

        const severity = threshold <= 10 ? "error" : "warning";
        createNotification({
          userId,
          type: "credits_low",
          title: "Low credit balance",
          message: `Your balance is ${newBalance} credits. Consider adding more to avoid interruptions.`,
          severity,
          metadata: { balance: newBalance, threshold },
        });

        try {
          const userEmail = await pool.query(
            `SELECT email FROM users WHERE id = $1`,
            [userId]
          );
          if (userEmail.rows.length > 0) {
            await sendLowBalanceEmail(
              userEmail.rows[0].email,
              newBalance,
              threshold
            );
          }
        } catch (emailErr) {
          console.error("[creditGate] low balance email error:", emailErr);
        }
      }
    }
  }

  for (const threshold of thresholds) {
    if (newBalance > threshold) {
      await pool.query(
        `DELETE FROM low_balance_alerts WHERE user_id = $1 AND threshold = $2`,
        [userId, threshold]
      );
    }
  }
}

async function getAlertThresholds(): Promise<number[]> {
  const result = await pool.query(
    `SELECT value FROM credit_settings WHERE key = 'low_balance_thresholds'`
  );
  if (result.rows.length > 0) {
    try {
      const parsed = JSON.parse(result.rows[0].value);
      if (Array.isArray(parsed)) return parsed.map(Number).filter((n) => !isNaN(n)).sort((a, b) => b - a);
    } catch {}
  }
  return [50, 20, 10];
}

async function handleWorkspacePostDebitAlerts(
  workspaceId: string,
  newBalance: number,
  cost: number,
  generationType: string
): Promise<void> {
  const admins = await pool.query(
    `SELECT wm.user_id FROM workspace_members wm
     WHERE wm.workspace_id = $1 AND wm.role IN ('owner', 'admin')`,
    [workspaceId]
  );

  const typeLabel = generationType.replace(/_/g, " ");

  for (const admin of admins.rows) {
    createNotification({
      userId: admin.user_id,
      type: "credits_used",
      title: "Workspace credits used",
      message: `${cost} workspace credits used for ${typeLabel}. Workspace balance: ${newBalance} credits.`,
      severity: "info",
      metadata: { cost, balance: newBalance, job_type: generationType, workspace_id: workspaceId },
    });
  }

  const thresholds = await getAlertThresholds();

  for (const threshold of thresholds) {
    if (newBalance <= threshold && newBalance + cost > threshold) {
      const existing = await pool.query(
        `SELECT 1 FROM low_balance_alerts WHERE workspace_id = $1 AND threshold = $2`,
        [workspaceId, threshold]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO low_balance_alerts (workspace_id, threshold)
           VALUES ($1, $2)
           ON CONFLICT DO NOTHING`,
          [workspaceId, threshold]
        );

        const severity = threshold <= 10 ? "error" : "warning";

        for (const admin of admins.rows) {
          createNotification({
            userId: admin.user_id,
            type: "credits_low",
            title: "Low workspace credit balance",
            message: `Workspace balance is ${newBalance} credits. Consider adding more to avoid interruptions.`,
            severity,
            metadata: { balance: newBalance, threshold, workspace_id: workspaceId },
          });

          try {
            const userEmail = await pool.query(
              `SELECT email FROM users WHERE id = $1`,
              [admin.user_id]
            );
            if (userEmail.rows.length > 0) {
              await sendLowBalanceEmail(
                userEmail.rows[0].email,
                newBalance,
                threshold
              );
            }
          } catch (emailErr) {
            console.error("[creditGate] workspace low balance email error:", emailErr);
          }
        }
      }
    }
  }

  for (const threshold of thresholds) {
    if (newBalance > threshold) {
      await pool.query(
        `DELETE FROM low_balance_alerts WHERE workspace_id = $1 AND threshold = $2`,
        [workspaceId, threshold]
      );
    }
  }
}

export async function grantWorkspaceCredits(
  workspaceId: string,
  credits: number,
  userId: string,
  reason: string,
  referenceId: string,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `WITH ws_update AS (
         INSERT INTO workspace_credits (workspace_id, balance)
         VALUES ($2, $3)
         ON CONFLICT (workspace_id) DO UPDATE SET balance = workspace_credits.balance + $3, updated_at = NOW()
         RETURNING balance
       ),
       ledger_insert AS (
         INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason, reference_id, metadata)
         SELECT $1, $2, $3, w.balance, $4, $5, $6
         FROM ws_update w
         ON CONFLICT (reason, reference_id) WHERE reference_id IS NOT NULL DO NOTHING
         RETURNING id
       )
       SELECT l.id AS ledger_id, w.balance AS new_balance
       FROM ledger_insert l, ws_update w`,
      [userId, workspaceId, credits, reason, referenceId, JSON.stringify(metadata)]
    );

    if (result.rows.length === 0) {
      await client.query("ROLLBACK");
      console.log(`[payments] Workspace credits already granted for ${reason} ref=${referenceId}`);
      return false;
    }

    await client.query("COMMIT");
    console.log(`[payments] Granted ${credits} workspace credits to workspace=${workspaceId}, reason=${reason}`);

    pool.query(
      `DELETE FROM low_balance_alerts WHERE workspace_id = $1`,
      [workspaceId]
    ).catch((err) => console.error("[creditGate] failed to clear workspace low balance alerts:", err));

    return true;
  } catch (err) {
    await client.query("ROLLBACK");
    if ((err as { code?: string }).code === "23505") {
      console.log(`[payments] Duplicate workspace credit grant prevented for ${reason}`);
      return false;
    }
    throw err;
  } finally {
    client.release();
  }
}

// ─── Token-based agent reservation + settlement ───────────────────────────
//
// `reserveAgentCredits` pre-debits a worst-case credit amount up-front using
// the existing checkAndDebit flow (same 402 / "insufficient credits" UX as
// today's character-based path). After Anthropic finishes streaming and we
// know the real input/output token counts, `settleAgentCredits` either
// refunds the unused portion or — in the rare case where actual cost
// overshot the reservation — debits the small remaining delta. The result
// is one debit + at most one settlement entry per agent turn so support and
// admin tooling can audit the full cost from the ledger alone.

export type AgentReservation = {
  ledgerId: string;
  reservedCost: number;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  modelKey: string;
};

export async function reserveAgentCredits(args: {
  userId: string;
  modelKey: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  referenceId: string;
  orgId?: string;
}): Promise<DebitResult & { reservation?: AgentReservation }> {
  const result = await checkAndDebit(
    args.userId,
    "agent_chat",
    1,
    args.referenceId,
    args.orgId,
    {
      modelKey: args.modelKey,
      inputTokens: args.estimatedInputTokens,
      outputTokens: args.maxOutputTokens,
    }
  );
  if (!result.success) return result;
  return {
    ...result,
    reservation: {
      ledgerId: result.ledgerId,
      reservedCost: result.cost,
      estimatedInputTokens: args.estimatedInputTokens,
      maxOutputTokens: args.maxOutputTokens,
      modelKey: args.modelKey,
    },
  };
}

export async function settleAgentCredits(args: {
  userId: string;
  modelKey: string;
  reservedCost: number;
  reservationLedgerId: string;
  actualInputTokens: number;
  actualOutputTokens: number;
  referenceId: string;
  orgId?: string;
}): Promise<{ actualCost: number; delta: number; settlementLedgerId: string | null }> {
  const costResult = await calculateModelCost("agent_chat", 1, {
    modelKey: args.modelKey,
    inputTokens: args.actualInputTokens,
    outputTokens: args.actualOutputTokens,
  });
  if ("error" in costResult) {
    // Pricing row vanished mid-stream or token rates went to 0 — refund the
    // whole reservation rather than charging the user for an unbillable call.
    if (args.reservedCost > 0) {
      await refundCreditsWithFallback(
        args.userId,
        args.reservedCost,
        "agent_chat_unbillable",
        args.referenceId,
        args.orgId,
      );
    }
    return { actualCost: 0, delta: args.reservedCost, settlementLedgerId: null };
  }

  const actualCost = costResult.totalCost;
  const delta = args.reservedCost - actualCost;

  // Settlement metadata always carries the *actual* token-cost numbers so a
  // single ledger row per turn (reservation OR settlement) is enough for
  // support/admins to reconstruct the bill. We attach `model` explicitly so
  // /api/usage's per-model attribution stays correct even when grouped on
  // refund rows (otherwise refunds would land in `unknown` and inflate
  // Sonnet's apparent net cost).
  const settlementMetadata = {
    ...costResult.breakdown,
    reserved_cost: args.reservedCost,
    actual_cost: actualCost,
    delta_credits: delta,
    reservation_ledger_id: args.reservationLedgerId,
  };

  if (delta === 0) {
    return { actualCost, delta: 0, settlementLedgerId: null };
  }

  if (delta > 0) {
    // Refund unused portion. Reason is namespaced separately from
    // agent_chat_cancelled / agent_chat_failed so support can tell the
    // difference between "user got money back because the call was
    // cheaper than the worst-case estimate" vs. "user got their money
    // back because the call never completed".
    await refundCreditsWithFallback(
      args.userId,
      delta,
      "agent_chat_settlement",
      args.referenceId,
      args.orgId,
      settlementMetadata,
    );
    return { actualCost, delta, settlementLedgerId: null };
  }

  // delta < 0: actual cost overshot reservation (unusual — only happens if
  // input estimation was too low). Charge the small remaining amount as a
  // single settlement debit, recording the breakdown for auditability.
  const extra = -delta;
  const ledgerId = await debitAgentSettlement({
    userId: args.userId,
    amount: extra,
    referenceId: args.referenceId,
    orgId: args.orgId,
    metadata: settlementMetadata,
  });
  return { actualCost, delta, settlementLedgerId: ledgerId };
}

async function debitAgentSettlement(args: {
  userId: string;
  amount: number;
  referenceId: string;
  orgId?: string;
  metadata: Record<string, unknown>;
}): Promise<string | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const wsInfo = await resolveWorkspaceForUser(args.userId, args.orgId, client);
    const useWorkspaceCredits = wsInfo !== null && wsInfo.isOrg;

    // Read the current balance under FOR UPDATE so the deduction is
    // exactly what we record on the ledger, even if the balance can't
    // cover the full overshoot. This prevents a row that says "-50" from
    // being inserted when only 30 credits were actually subtracted.
    let previousBalance = 0;
    if (useWorkspaceCredits) {
      const cur = await client.query(
        `SELECT balance FROM workspace_credits WHERE workspace_id = $1 FOR UPDATE`,
        [wsInfo.workspaceId]
      );
      previousBalance = cur.rows.length > 0 ? Number(cur.rows[0].balance) : 0;
    } else {
      const cur = await client.query(
        `SELECT balance FROM credits WHERE user_id = $1 FOR UPDATE`,
        [args.userId]
      );
      previousBalance = cur.rows.length > 0 ? Number(cur.rows[0].balance) : 0;
    }
    const actualDeducted = Math.max(0, Math.min(args.amount, previousBalance));
    const newBalance = previousBalance - actualDeducted;

    if (actualDeducted > 0) {
      if (useWorkspaceCredits) {
        await client.query(
          `UPDATE workspace_credits SET balance = $2, updated_at = NOW() WHERE workspace_id = $1`,
          [wsInfo.workspaceId, newBalance]
        );
      } else {
        await client.query(
          `UPDATE credits SET balance = $2, updated_at = NOW() WHERE user_id = $1`,
          [args.userId, newBalance]
        );
      }
    }

    const ledgerResult = await client.query(
      `INSERT INTO credit_ledger (user_id, org_id, amount, balance_after, reason, reference_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        args.userId,
        useWorkspaceCredits ? wsInfo.workspaceId : null,
        -actualDeducted,
        newBalance,
        `agent_chat_settlement`,
        args.referenceId,
        JSON.stringify({
          ...args.metadata,
          requested_debit: args.amount,
          actual_deducted: actualDeducted,
          workspace_billing: useWorkspaceCredits,
        }),
      ]
    );

    await client.query("COMMIT");
    return ledgerResult.rows[0].id;
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("[creditGate] agent settlement debit failed:", err);
    return null;
  } finally {
    client.release();
  }
}
