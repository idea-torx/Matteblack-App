import { PRESENCE_CURSOR_RATE_PER_SEC } from "../../../shared/presence.js";

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const CAPACITY = PRESENCE_CURSOR_RATE_PER_SEC;
const REFILL_PER_MS = PRESENCE_CURSOR_RATE_PER_SEC / 1000;
const IDLE_BUCKET_TTL_MS = 60_000;

const buckets = new Map<string, Bucket>();

function refill(bucket: Bucket, now: number): void {
  const elapsed = now - bucket.lastRefillMs;
  if (elapsed <= 0) return;
  const tokens = bucket.tokens + elapsed * REFILL_PER_MS;
  bucket.tokens = tokens > CAPACITY ? CAPACITY : tokens;
  bucket.lastRefillMs = now;
}

export function tryConsume(sessionId: string, now: number = Date.now()): boolean {
  if (!sessionId) return false;
  let bucket = buckets.get(sessionId);
  if (!bucket) {
    bucket = { tokens: CAPACITY, lastRefillMs: now };
    buckets.set(sessionId, bucket);
  }
  refill(bucket, now);
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

export function release(sessionId: string): void {
  buckets.delete(sessionId);
}

export function sweepIdleBuckets(now: number = Date.now()): void {
  for (const [sessionId, bucket] of buckets) {
    if (now - bucket.lastRefillMs > IDLE_BUCKET_TTL_MS) {
      buckets.delete(sessionId);
    }
  }
}

export function _resetForTests(): void {
  buckets.clear();
}
