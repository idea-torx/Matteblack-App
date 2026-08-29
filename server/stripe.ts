import type Stripe from "stripe";
import { createRequire } from "node:module";

// Type-only import above (erased at build) + a lazy runtime require here, so the
// local/desktop build — which never sets STRIPE_SECRET_KEY — doesn't need the
// `stripe` package at all and it can be excluded from the bundle. The renamed
// `nodeRequire` is invisible to esbuild's require handling, so it stays a real
// runtime require of an external package.
const nodeRequire = createRequire(import.meta.url);

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;

if (!STRIPE_SECRET_KEY) {
  console.warn("[stripe] STRIPE_SECRET_KEY not set — Stripe features will be unavailable");
}

function newStripe(key: string): Stripe {
  const mod = nodeRequire("stripe");
  const StripeCtor = (mod.default ?? mod) as typeof Stripe;
  return new StripeCtor(key);
}

export const stripe: Stripe | null = STRIPE_SECRET_KEY
  ? newStripe(STRIPE_SECRET_KEY)
  : null;

export const isStripeConfigured = (): boolean => stripe !== null;

export function requireStripe(): Stripe {
  if (!stripe) {
    throw new Error("Stripe is not configured. Set STRIPE_SECRET_KEY environment variable.");
  }
  return stripe;
}

export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";

export function requireWebhookSecret(): string {
  if (!STRIPE_WEBHOOK_SECRET) {
    throw new Error("STRIPE_WEBHOOK_SECRET is not configured. Webhook processing is disabled.");
  }
  return STRIPE_WEBHOOK_SECRET;
}
export const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || "";

export const CREDITS_PER_DOLLAR = 100;

// Platform-wide margin applied on top of net Anthropic cost when billing
// token-based models (currently only the Claude Sonnet agent). Admins enter
// the *net* Anthropic price per 1M tokens in the model_pricing table; the
// 25% margin is added automatically at billing time. Making this per-model
// is future work — see task #402 / "Out of scope".
export const AGENT_MARGIN_MULTIPLIER = 1.25;

export const PLAN_CONFIG: Record<string, { priceId: string; creditsPerPeriod: number; amountCents: number }> = {
  starter: {
    priceId: process.env.STRIPE_PRICE_STARTER || "price_starter_placeholder",
    creditsPerPeriod: 3050,
    amountCents: 2900,
  },
  pro: {
    priceId: process.env.STRIPE_PRICE_PRO || "price_pro_placeholder",
    creditsPerPeriod: 6500,
    amountCents: 5900,
  },
  power: {
    priceId: process.env.STRIPE_PRICE_POWER || "price_power_placeholder",
    creditsPerPeriod: 13700,
    amountCents: 11900,
  },
};

export const MAX_PURCHASE_CENTS = 50000;
export const MIN_PURCHASE_CENTS = 100;
