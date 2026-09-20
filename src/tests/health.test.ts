// src/tests/health.test.ts
import assert from 'node:assert';
import test, { afterEach, beforeEach } from 'node:test';

process.env.TEST_MOCK_PLAYWRIGHT = 'true';
process.env.API_KEY = 'test-key-for-health';

import { app } from '../index.tsx';
import { accounts, rebuildEmailIndex } from '../services/accountManager.ts';
import { getAuthPhase, resetAuthPhase, setAuthPhase } from '../services/healthState.ts';

const TEST_API_KEY = 'test-key-for-health';
const authHeaders = { Authorization: `Bearer ${TEST_API_KEY}` };

beforeEach(() => {
  resetAuthPhase();
});

afterEach(() => {
  resetAuthPhase();
});

async function makeHealthRequest(): Promise<{ status: number; body: Record<string, unknown> }> {
  const req = new Request('http://localhost/health');
  const res = await app.fetch(req);
  const body = (await res.json()) as Record<string, unknown>;
  return { status: res.status, body };
}

test('Health returns starting when auth_phase is idle', async () => {
  setAuthPhase('idle');
  const { status, body } = await makeHealthRequest();

  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'starting');
  assert.strictEqual(body.auth_phase, 'idle');
  assert.strictEqual(typeof body.uptime_seconds, 'number');
  assert.ok((body.uptime_seconds as number) >= 0);
});

test('Health returns starting when auth_phase is initializing', async () => {
  setAuthPhase('initializing');
  const { status, body } = await makeHealthRequest();

  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'starting');
  assert.strictEqual(body.auth_phase, 'initializing');
});

test('Health returns degraded when auth_phase is failed', async () => {
  setAuthPhase('failed');
  const { status, body } = await makeHealthRequest();

  assert.strictEqual(status, 200);
  assert.strictEqual(body.status, 'degraded');
  assert.strictEqual(body.auth_phase, 'failed');
});

test('Health returns degraded when auth ready but zero available accounts', async () => {
  const originalAccounts = [...accounts];
  try {
    // Empty the pool: no accounts means available === 0.
    accounts.length = 0;
    rebuildEmailIndex();
    setAuthPhase('ready');

    const { status, body } = await makeHealthRequest();

    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'degraded');
    assert.strictEqual(body.auth_phase, 'ready');
    const accts = body.accounts as Record<string, number>;
    assert.strictEqual(accts.available, 0);
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    rebuildEmailIndex();
  }
});

test('Health returns ok when auth ready and accounts available', async () => {
  const originalAccounts = [...accounts];
  try {
    // Seed a healthy account — authenticated + not throttled = available.
    accounts.push({
      email: 'health-ok@qwen-gate.dev',
      password: 'test',
      state: { token: 'mock-token', expiresAt: Date.now() + 3600000, refreshToken: null },
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      startupStatus: 'ready',
    });
    rebuildEmailIndex();
    setAuthPhase('ready');

    const { status, body } = await makeHealthRequest();

    assert.strictEqual(status, 200);
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.auth_phase, 'ready');
    assert.strictEqual(body.worker_phase, 'idle');
    const accts = body.accounts as Record<string, number>;
    assert.ok(accts.total >= 1);
    assert.ok(accts.available >= 1);
    assert.ok(accts.authenticated >= 1);
    assert.strictEqual(typeof body.inFlight, 'number');
  } finally {
    accounts.splice(0, accounts.length, ...originalAccounts);
    rebuildEmailIndex();
  }
});

test('Health response includes APP_VERSION from version module', async () => {
  setAuthPhase('idle');
  const { body } = await makeHealthRequest();
  // APP_VERSION comes from package.json — just verify it's a non-empty string.
  assert.strictEqual(typeof body.version, 'string');
  assert.ok((body.version as string).length > 0);
});