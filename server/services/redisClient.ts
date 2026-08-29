import type Redis from "ioredis";
import { createRequire } from "node:module";

// Type-only import + lazy require: the local build never sets REDIS_URL, so the
// `ioredis` package is never loaded and can be dropped from the bundle.
const nodeRequire = createRequire(import.meta.url);

let redisClient: Redis | null = null;

const redisUrl =
  process.env.NODE_ENV !== "production" && process.env.REDIS_URL_DEV
    ? process.env.REDIS_URL_DEV
    : process.env.REDIS_URL;

if (redisUrl) {
  const mod = nodeRequire("ioredis");
  const RedisCtor = (mod.default ?? mod) as typeof Redis;
  redisClient = new RedisCtor(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    lazyConnect: false,
  });

  redisClient.on("connect", () => {
    const instance =
      process.env.NODE_ENV !== "production" && process.env.REDIS_URL_DEV
        ? "dev"
        : "prod";
    console.log(`[redis] Connected to Redis (${instance})`);
  });

  redisClient.on("error", (err) => {
    console.error("[redis] Redis client error:", err);
  });
} else {
  console.warn("[redis] REDIS_URL not set — Redis cache disabled, falling back to direct Postgres writes");
}

export default redisClient;
