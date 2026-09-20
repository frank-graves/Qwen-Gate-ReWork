import type { Context } from 'hono';
import { config } from '../services/configService.ts';

export interface RateLimitConfig {
  requests_per_minute: number;
  tokens_per_request: number;
  burst_allowance: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number;
}

const buckets = new Map<string, BucketState>();

// The cap is a safety valve: cleanupIdleBuckets only runs every
// 15 minutes, so a burst of spoofed IPs can blow past it.
let maxBuckets = Math.max(1, config.getInt('MAX_RATE_LIMIT_BUCKETS', 10000));

const DEFAULT_CONFIG: RateLimitConfig = {
  requests_per_minute: 60,
  tokens_per_request: 1,
  burst_allowance: 10,
};

export class TokenBucket {
  private key: string;
  private config: RateLimitConfig;
  private maxTokens: number;

  constructor(key: string, config: Partial<RateLimitConfig> = {}) {
    this.key = key;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.maxTokens = this.config.requests_per_minute + this.config.burst_allowance;
  }

  private getBucket(): BucketState {
    const existing = buckets.get(this.key);
    if (existing) return existing;

    const initial: BucketState = {
      tokens: this.maxTokens,
      lastRefill: Date.now(),
    };
    buckets.set(this.key, initial);

    // Enforce cap after insertion — only runs when we exceed the limit,
    // keeping the fast path (size <= maxBuckets) untouched.
    if (buckets.size > maxBuckets) {
      evictOldestBuckets(maxBuckets);
    }

    return initial;
  }

  private refill(bucket: BucketState): void {
    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const elapsedMinutes = elapsedMs / 60000;

    const tokensToAdd = elapsedMinutes * this.config.requests_per_minute;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }

  private calculateRetryAfter(bucket: BucketState): number {
    const tokensNeeded = this.config.tokens_per_request - bucket.tokens;
    if (tokensNeeded <= 0) return 0;

    const tokensPerSecond = this.config.requests_per_minute / 60;
    return Math.max(0.1, tokensNeeded / tokensPerSecond);
  }

  tryConsume(tokens: number = this.config.tokens_per_request): boolean {
    const bucket = this.getBucket();
    this.refill(bucket);

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      return true;
    }
    return false;
  }

  getHeaders(): Record<string, string> {
    const bucket = this.getBucket();
    const retryAfter = this.calculateRetryAfter(bucket);

    return {
      'X-RateLimit-Limit': String(this.maxTokens),
      'X-RateLimit-Remaining': String(Math.floor(bucket.tokens)),
      'X-RateLimit-Reset': String(Math.ceil((bucket.lastRefill + 60000) / 1000)),
      ...(retryAfter > 0 ? { 'Retry-After': String(retryAfter) } : {}),
    };
  }
}

const bucketInstances = new Map<string, TokenBucket>();

function evictOldestBuckets(maxSize: number): void {
  // Sort by lastRefill ascending, then delete the oldest entries.
  // This is O(n log n) but only runs when we exceed the cap, which is rare.
  const entries = Array.from(buckets.entries());
  entries.sort((a, b) => a[1].lastRefill - b[1].lastRefill);

  const toEvict = buckets.size - maxSize;
  for (let i = 0; i < toEvict; i++) {
    const [key] = entries[i];
    buckets.delete(key);
    bucketInstances.delete(key);
  }
}

export async function rateLimitMiddleware(c: Context, key: string, config?: Partial<RateLimitConfig>): Promise<Response | null> {
  const forwarded = c.req.header('x-forwarded-for');
  const clientIp = forwarded?.split(',')[0]?.trim() || c.req.header('x-real-ip') || 'unknown';
  const clientKey = `${key}:${clientIp}`;
  let bucket = bucketInstances.get(clientKey);
  if (!bucket) {
    bucket = new TokenBucket(clientKey, config);
    bucketInstances.set(clientKey, bucket);
  }
  const consumed = bucket.tryConsume();

  if (!consumed) {
    const headers = bucket.getHeaders();
    return c.json({ error: 'Rate limit exceeded', message: 'Too many requests' }, { status: 429, headers });
  }

  const headers = bucket.getHeaders();
  c.header('X-RateLimit-Limit', headers['X-RateLimit-Limit']);
  c.header('X-RateLimit-Remaining', headers['X-RateLimit-Remaining']);
  c.header('X-RateLimit-Reset', headers['X-RateLimit-Reset']);

  return null;
}

export function cleanupIdleBuckets(maxIdleMinutes: number = 60): void {
  const now = Date.now();
  const maxIdleMs = maxIdleMinutes * 60 * 1000;

  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.lastRefill > maxIdleMs) {
      buckets.delete(key);
      bucketInstances.delete(key);
    }
  }
}

const CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startAutoCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    cleanupIdleBuckets(60);
  }, CLEANUP_INTERVAL_MS);
  if (cleanupTimer && typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }
}

export function stopAutoCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** @internal — exposed for testing only */
export function _getBucketKeysForTest(): string[] {
  return Array.from(buckets.keys());
}

/** @internal — exposed for testing only. Clears all state and re-reads config. */
export function _resetRateLimitForTest(): void {
  buckets.clear();
  bucketInstances.clear();
  maxBuckets = Math.max(1, config.getInt('MAX_RATE_LIMIT_BUCKETS', 10000));
}

/** @internal — exposed for testing only */
export function _setLastRefillForTest(key: string, timestamp: number): void {
  const bucket = buckets.get(key);
  if (bucket) {
    bucket.lastRefill = timestamp;
  }
}
