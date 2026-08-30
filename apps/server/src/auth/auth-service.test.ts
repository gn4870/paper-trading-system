import { describe, expect, it } from "vitest";

import { AccountLedger } from "../accounts/account-ledger.js";
import type { Clock, IdGenerator } from "../infrastructure/event-journal.js";
import { MemoryState } from "../infrastructure/memory-state.js";
import { AuthService } from "./auth-service.js";
import { verifyPassword } from "./password.js";

const instant = "2026-08-29T00:00:00.000Z";

const createAuthHarness = () => {
  const state = new MemoryState();
  const ledger = new AccountLedger(state);
  const clock: Clock = { now: () => instant };
  let nextId = 0;
  const ids: IdGenerator = { next: () => `auth-id-${++nextId}` };
  const auth = new AuthService(state, ledger, clock, ids);
  return { state, ledger, auth };
};

describe("AuthService", () => {
  it("normalizes a username and creates a funded account", async () => {
    const h = createAuthHarness();

    const result = await h.auth.register(" Trader_01 ", "safe-pass-123");

    expect(result.user).toEqual({ id: "auth-id-1", username: "trader_01" });
    expect(h.ledger.snapshot(result.user.id).cashAvailableMinor).toBe(
      100_000_000
    );
    expect(h.state.users.get(result.user.id)?.kind).toBe("REAL");
  });

  it("stores a verifiable scrypt digest instead of the password", async () => {
    const h = createAuthHarness();

    const result = await h.auth.register("trader_01", "safe-pass-123");
    const digest = h.state.users.get(result.user.id)?.passwordDigest;

    expect(digest).toEqual(expect.any(String));
    expect(digest).not.toContain("safe-pass-123");
    await expect(verifyPassword("safe-pass-123", digest!)).resolves.toBe(true);
    await expect(verifyPassword("wrong-pass", digest!)).resolves.toBe(false);
  });

  it("rejects a duplicate normalized username", async () => {
    const h = createAuthHarness();
    await h.auth.register("Trader_01", "safe-pass-123");

    await expect(
      h.auth.register("trader_01", "different-123")
    ).rejects.toMatchObject({ code: "USERNAME_TAKEN", status: 409 });
    expect(h.state.users).toHaveLength(1);
  });

  it("returns the same safe failure for an unknown username and bad password", async () => {
    const h = createAuthHarness();
    await h.auth.register("trader_01", "safe-pass-123");

    const unknown = await h.auth
      .login("missing_01", "safe-pass-123")
      .catch((error: unknown) => error);
    const wrong = await h.auth
      .login("TRADER_01", "wrong-pass-123")
      .catch((error: unknown) => error);

    expect(unknown).toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
      message: "用户名或密码错误"
    });
    expect(wrong).toMatchObject({
      code: "INVALID_CREDENTIALS",
      status: 401,
      message: "用户名或密码错误"
    });
  });

  it("creates restart-scoped sessions that logout invalidates", async () => {
    const h = createAuthHarness();
    const registered = await h.auth.register("trader_01", "safe-pass-123");

    expect(registered.sessionId).toBe("auth-id-2");
    expect(h.state.sessions.get(registered.sessionId)).toEqual({
      id: "auth-id-2",
      userId: "auth-id-1",
      createdAt: instant
    });
    expect(h.auth.resolveSession(registered.sessionId)).toEqual(
      registered.user
    );

    h.auth.logout(registered.sessionId);

    expect(h.auth.resolveSession(registered.sessionId)).toBeUndefined();
    expect(h.state.sessions).toHaveLength(0);
  });

  it("notifies isolated listeners after a session is invalidated", async () => {
    const h = createAuthHarness();
    const registered = await h.auth.register("trader_01", "safe-pass-123");
    const observed: Array<{ sessionId: string; alreadyDeleted: boolean }> = [];
    h.auth.onSessionInvalidated(() => {
      throw new Error("listener failed");
    });
    const unsubscribe = h.auth.onSessionInvalidated((sessionId) => {
      observed.push({
        sessionId,
        alreadyDeleted: h.auth.resolveSession(sessionId) === undefined
      });
    });

    h.auth.logout(registered.sessionId);
    h.auth.logout(registered.sessionId);
    unsubscribe();

    expect(observed).toEqual([
      { sessionId: registered.sessionId, alreadyDeleted: true }
    ]);
  });

  it("treats malformed stored digests as failed verification", async () => {
    await expect(
      verifyPassword("safe-pass-123", "not-a-valid-digest")
    ).resolves.toBe(false);
  });
});
