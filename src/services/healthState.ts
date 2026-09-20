// src/services/healthState.ts
// Auth phase lives here because initAuth() is called from the background boot
// IIFE in index.tsx, but the health endpoint reads it from a Hono handler
// registered before that IIFE even starts. A shared module avoids the race.

export type AuthPhase = 'idle' | 'initializing' | 'ready' | 'failed';

let authPhase: AuthPhase = 'idle';

export function getAuthPhase(): AuthPhase {
  return authPhase;
}

export function setAuthPhase(phase: AuthPhase): void {
  authPhase = phase;
}

export function resetAuthPhase(): void {
  // Tests call this to avoid leaking phase state across cases.
  authPhase = 'idle';
}
