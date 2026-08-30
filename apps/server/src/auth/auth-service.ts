import { loginSchema, registerSchema } from "@paper/shared";

import { AccountLedger } from "../accounts/account-ledger.js";
import type { Clock, IdGenerator } from "../infrastructure/event-journal.js";
import {
  MemoryState,
  type UserRecord
} from "../infrastructure/memory-state.js";
import { hashPassword, verifyPassword } from "./password.js";

export interface AuthUser {
  id: string;
  username: string;
}

export interface AuthResult {
  user: AuthUser;
  sessionId: string;
}

export type AuthErrorCode = "USERNAME_TAKEN" | "INVALID_CREDENTIALS";
export type SessionInvalidationListener = (sessionId: string) => void;

export class AuthError extends Error {
  constructor(
    public readonly code: AuthErrorCode,
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = "AuthError";
  }
}

const defaultClock: Clock = { now: () => new Date().toISOString() };
const defaultIds: IdGenerator = { next: () => crypto.randomUUID() };
const dummyDigest =
  "scrypt-v1:00000000000000000000000000000000:" + "00".repeat(64);

const publicUser = (record: UserRecord): AuthUser => ({
  id: record.id,
  username: record.username
});

export class AuthService {
  private readonly sessionInvalidationListeners =
    new Set<SessionInvalidationListener>();

  constructor(
    private readonly state: MemoryState,
    private readonly ledger: AccountLedger,
    private readonly clock: Clock = defaultClock,
    private readonly ids: IdGenerator = defaultIds
  ) {}

  async register(username: string, password: string): Promise<AuthResult> {
    const parsed = registerSchema.parse({ username, password });
    this.assertUsernameAvailable(parsed.username);
    const passwordDigest = await hashPassword(parsed.password);
    this.assertUsernameAvailable(parsed.username);

    const user: UserRecord = {
      id: this.ids.next(),
      username: parsed.username,
      normalizedUsername: parsed.username,
      passwordDigest,
      kind: "REAL"
    };
    this.state.users.set(user.id, user);
    try {
      this.ledger.createRealAccount(user.id);
    } catch (error) {
      this.state.users.delete(user.id);
      throw error;
    }

    return { user: publicUser(user), sessionId: this.createSession(user.id) };
  }

  async login(username: string, password: string): Promise<AuthResult> {
    const parsed = loginSchema.parse({ username, password });
    const found = [...this.state.users.values()].find(
      (user) =>
        user.kind === "REAL" && user.normalizedUsername === parsed.username
    );
    const verified = await verifyPassword(
      parsed.password,
      found?.passwordDigest ?? dummyDigest
    );
    if (found === undefined || !verified) {
      throw new AuthError("INVALID_CREDENTIALS", 401, "用户名或密码错误");
    }

    return {
      user: publicUser(found),
      sessionId: this.createSession(found.id)
    };
  }

  logout(sessionId: string): void {
    if (!this.state.sessions.delete(sessionId)) return;
    for (const listener of [...this.sessionInvalidationListeners]) {
      try {
        listener(sessionId);
      } catch {
        // One listener cannot prevent other session consumers from revoking.
      }
    }
  }

  onSessionInvalidated(listener: SessionInvalidationListener): () => void {
    this.sessionInvalidationListeners.add(listener);
    return () => {
      this.sessionInvalidationListeners.delete(listener);
    };
  }

  resolveSession(sessionId: string): AuthUser | undefined {
    const session = this.state.sessions.get(sessionId);
    if (session === undefined) return undefined;
    const user = this.state.users.get(session.userId);
    if (user === undefined || user.kind !== "REAL") return undefined;
    return publicUser(user);
  }

  private assertUsernameAvailable(normalizedUsername: string): void {
    const exists = [...this.state.users.values()].some(
      (user) => user.normalizedUsername === normalizedUsername
    );
    if (exists) {
      throw new AuthError("USERNAME_TAKEN", 409, "用户名已被使用");
    }
  }

  private createSession(userId: string): string {
    const id = this.ids.next();
    this.state.sessions.set(id, { id, userId, createdAt: this.clock.now() });
    return id;
  }
}
