import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { _getBucketKeysForTest, _resetRateLimitForTest, _setLastRefillForTest, TokenBucket } from './rateLimit.ts';

describe('Rate limit bucket cap', () => {
  const originalEnv = process.env.MAX_RATE_LIMIT_BUCKETS;

  beforeEach(() => {
    _resetRateLimitForTest();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.MAX_RATE_LIMIT_BUCKETS;
    } else {
      process.env.MAX_RATE_LIMIT_BUCKETS = originalEnv;
    }
    _resetRateLimitForTest();
  });

  it('under the cap: no eviction', () => {
    process.env.MAX_RATE_LIMIT_BUCKETS = '10';
    _resetRateLimitForTest();

    for (let i = 0; i < 5; i++) {
      const bucket = new TokenBucket(`key-${i}`);
      bucket.tryConsume();
    }

    const keys = _getBucketKeysForTest();
    expect(keys.length).toBe(5);
  });

  it('at the cap: no eviction yet', () => {
    process.env.MAX_RATE_LIMIT_BUCKETS = '10';
    _resetRateLimitForTest();

    for (let i = 0; i < 10; i++) {
      const bucket = new TokenBucket(`key-${i}`);
      bucket.tryConsume();
    }

    const keys = _getBucketKeysForTest();
    expect(keys.length).toBe(10);
  });

  it('over the cap by 1: oldest bucket is evicted', () => {
    process.env.MAX_RATE_LIMIT_BUCKETS = '10';
    _resetRateLimitForTest();

    const baseTime = Date.now();

    for (let i = 0; i < 11; i++) {
      const bucket = new TokenBucket(`key-${i}`);
      bucket.tryConsume();
      _setLastRefillForTest(`key-${i}`, baseTime - (11 - i) * 1000);
    }

    const keys = _getBucketKeysForTest();
    expect(keys.length).toBe(10);
    expect(keys).not.toContain('key-0');
  });

  it('eviction order: oldest is evicted first', () => {
    process.env.MAX_RATE_LIMIT_BUCKETS = '3';
    _resetRateLimitForTest();

    const baseTime = Date.now();

    const bucketA = new TokenBucket('A');
    bucketA.tryConsume();
    _setLastRefillForTest('A', baseTime - 3000);

    const bucketB = new TokenBucket('B');
    bucketB.tryConsume();
    _setLastRefillForTest('B', baseTime - 2000);

    const bucketC = new TokenBucket('C');
    bucketC.tryConsume();
    _setLastRefillForTest('C', baseTime - 1000);

    const bucketD = new TokenBucket('D');
    bucketD.tryConsume();

    const keys = _getBucketKeysForTest();
    expect(keys.length).toBe(3);
    expect(keys).not.toContain('A');
    expect(keys).toContain('B');
    expect(keys).toContain('C');
    expect(keys).toContain('D');
  });

  it('no premature eviction: touched bucket is not evicted', () => {
    process.env.MAX_RATE_LIMIT_BUCKETS = '10';
    _resetRateLimitForTest();

    const baseTime = Date.now();

    const bucketA = new TokenBucket('A');
    bucketA.tryConsume();
    _setLastRefillForTest('A', baseTime - 3000);

    const bucketB = new TokenBucket('B');
    bucketB.tryConsume();
    _setLastRefillForTest('B', baseTime - 2000);

    const bucketC = new TokenBucket('C');
    bucketC.tryConsume();
    _setLastRefillForTest('C', baseTime - 1000);

    // Touch B — refill() updates lastRefill to now, protecting it from eviction
    bucketB.tryConsume();

    for (let i = 0; i < 10; i++) {
      const letter = String.fromCharCode(68 + i);
      const bucket = new TokenBucket(letter);
      bucket.tryConsume();
      _setLastRefillForTest(letter, baseTime - (10 - i) * 1000 - 5000);
    }

    const keys = _getBucketKeysForTest();
    expect(keys.length).toBe(10);
    expect(keys).toContain('B');
  });

  it('config integration: reads MAX_RATE_LIMIT_BUCKETS from env', () => {
    process.env.MAX_RATE_LIMIT_BUCKETS = '3';
    _resetRateLimitForTest();

    const baseTime = Date.now();

    for (let i = 0; i < 4; i++) {
      const bucket = new TokenBucket(`key-${i}`);
      bucket.tryConsume();
      _setLastRefillForTest(`key-${i}`, baseTime - (4 - i) * 1000);
    }

    const keys = _getBucketKeysForTest();
    expect(keys.length).toBe(3);
  });
});
