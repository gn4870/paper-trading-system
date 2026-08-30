import type { AccountSnapshot, OrderSide, SymbolCode } from "@paper/shared";

import { DomainError } from "../infrastructure/domain-error.js";
import { MemoryState } from "../infrastructure/memory-state.js";

const SYMBOLS: readonly SymbolCode[] = ["AAPL", "MSFT", "TSLA"];

const cloneAccount = (account: AccountSnapshot): AccountSnapshot => ({
  ...account,
  positions: {
    AAPL: { ...account.positions.AAPL },
    MSFT: { ...account.positions.MSFT },
    TSLA: { ...account.positions.TSLA }
  }
});

const accountStores = new WeakMap<MemoryState, Map<string, AccountSnapshot>>();

const accountStoreFor = (state: MemoryState): Map<string, AccountSnapshot> => {
  let store = accountStores.get(state);
  if (store === undefined) {
    store = new Map();
    accountStores.set(state, store);
  }
  return store;
};

export interface ReservationInput {
  userId: string;
  side: OrderSide;
  symbol: SymbolCode;
  limitPriceMinor: number;
  quantity: number;
}

export interface SettlementInput {
  buyerId: string;
  sellerId: string;
  symbol: SymbolCode;
  buyLimitPriceMinor: number;
  executionPriceMinor: number;
  quantity: number;
}

const createPositions = (): AccountSnapshot["positions"] => ({
  AAPL: { availableQuantity: 0, frozenQuantity: 0 },
  MSFT: { availableQuantity: 0, frozenQuantity: 0 },
  TSLA: { availableQuantity: 0, frozenQuantity: 0 }
});

const invariant = (message = "账户状态不合法"): never => {
  throw new DomainError("INVARIANT_VIOLATION", 500, message);
};

function assertOrderSide(side: unknown): asserts side is OrderSide {
  if (side !== "BUY" && side !== "SELL") {
    invariant("交易方向不合法");
  }
}

function assertSymbol(symbol: unknown): asserts symbol is SymbolCode {
  if (!SYMBOLS.includes(symbol as SymbolCode)) {
    invariant("股票代码不合法");
  }
}

const assertSafeNonNegativeInteger = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) {
    invariant();
  }
};

const assertPositiveSafeInteger = (value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invariant();
  }
};

const safeProduct = (left: number, right: number): number => {
  assertSafeNonNegativeInteger(left);
  assertPositiveSafeInteger(right);
  const product = left * right;
  assertSafeNonNegativeInteger(product);
  return product;
};

const assertAccountInvariant = (account: AccountSnapshot): void => {
  assertSafeNonNegativeInteger(account.cashAvailableMinor);
  assertSafeNonNegativeInteger(account.cashFrozenMinor);
  for (const symbol of SYMBOLS) {
    const position = account.positions[symbol];
    assertSafeNonNegativeInteger(position.availableQuantity);
    assertSafeNonNegativeInteger(position.frozenQuantity);
  }
};

export class AccountLedger {
  constructor(private readonly state: MemoryState) {}

  createRealAccount(userId: string): AccountSnapshot {
    return this.createAccount(userId, 100_000_000, {});
  }

  seedSystemAccount(
    userId: string,
    cashMinor: number,
    positions: Partial<Record<SymbolCode, number>>
  ): AccountSnapshot {
    return this.createAccount(userId, cashMinor, positions);
  }

  reserve(input: ReservationInput): void {
    this.assertReservationInput(input);
    const account = this.requireAccount(input.userId);

    if (input.side === "BUY") {
      const amount = this.buyReservationAmount(input);
      if (account.cashAvailableMinor < amount) {
        throw new DomainError("INSUFFICIENT_FUNDS", 409, "可用资金不足");
      }
      account.cashAvailableMinor -= amount;
      account.cashFrozenMinor += amount;
    } else {
      const position = account.positions[input.symbol];
      if (position.availableQuantity < input.quantity) {
        throw new DomainError("INSUFFICIENT_POSITION", 409, "可用持仓不足");
      }
      position.availableQuantity -= input.quantity;
      position.frozenQuantity += input.quantity;
    }

    this.saveAccounts([account]);
  }

  release(input: ReservationInput): void {
    this.assertReservationInput(input);
    const account = this.requireAccount(input.userId);

    if (input.side === "BUY") {
      const amount = this.buyReservationAmount(input);
      if (account.cashFrozenMinor < amount) {
        invariant();
      }
      account.cashFrozenMinor -= amount;
      account.cashAvailableMinor += amount;
    } else {
      const position = account.positions[input.symbol];
      if (position.frozenQuantity < input.quantity) {
        invariant();
      }
      position.frozenQuantity -= input.quantity;
      position.availableQuantity += input.quantity;
    }

    this.saveAccounts([account]);
  }

  settle(input: SettlementInput): void {
    this.assertSettlementInput(input);

    if (input.buyerId === input.sellerId) {
      this.settleSameAccount(input);
      return;
    }

    const buyer = this.requireAccount(input.buyerId);
    const seller = this.requireAccount(input.sellerId);
    const reservedCash = safeProduct(input.buyLimitPriceMinor, input.quantity);
    const executionCash = safeProduct(
      input.executionPriceMinor,
      input.quantity
    );
    const refund = reservedCash - executionCash;

    if (buyer.cashFrozenMinor < reservedCash) {
      invariant();
    }
    if (seller.positions[input.symbol].frozenQuantity < input.quantity) {
      invariant();
    }

    buyer.cashFrozenMinor -= reservedCash;
    buyer.cashAvailableMinor += refund;
    buyer.positions[input.symbol].availableQuantity += input.quantity;

    seller.positions[input.symbol].frozenQuantity -= input.quantity;
    seller.cashAvailableMinor += executionCash;

    this.saveAccounts([buyer, seller]);
  }

  transact<T>(operation: () => T): T {
    const store = accountStoreFor(this.state);
    const before = new Map(
      [...store].map(([userId, account]) => [userId, cloneAccount(account)])
    );
    try {
      return operation();
    } catch (error) {
      store.clear();
      for (const [userId, account] of before) {
        store.set(userId, cloneAccount(account));
      }
      throw error;
    }
  }

  snapshot(userId: string): AccountSnapshot {
    return this.requireAccount(userId);
  }

  private createAccount(
    userId: string,
    cashMinor: number,
    suppliedPositions: Partial<Record<SymbolCode, number>>
  ): AccountSnapshot {
    if (this.hasAccount(userId)) {
      invariant();
    }
    assertSafeNonNegativeInteger(cashMinor);

    const positions = createPositions();
    for (const symbol of SYMBOLS) {
      const quantity = suppliedPositions[symbol] ?? 0;
      assertSafeNonNegativeInteger(quantity);
      positions[symbol].availableQuantity = quantity;
    }

    const account: AccountSnapshot = {
      userId,
      cashAvailableMinor: cashMinor,
      cashFrozenMinor: 0,
      positions
    };
    this.saveAccounts([account]);
    return this.snapshot(userId);
  }

  private assertReservationInput(input: ReservationInput): void {
    assertOrderSide(input.side);
    assertSymbol(input.symbol);
    assertPositiveSafeInteger(input.quantity);
    assertSafeNonNegativeInteger(input.limitPriceMinor);
  }

  private buyReservationAmount(input: ReservationInput): number {
    return safeProduct(input.limitPriceMinor, input.quantity);
  }

  private assertSettlementInput(input: SettlementInput): void {
    assertSymbol(input.symbol);
    safeProduct(input.buyLimitPriceMinor, input.quantity);
    safeProduct(input.executionPriceMinor, input.quantity);
    if (input.executionPriceMinor > input.buyLimitPriceMinor) {
      invariant();
    }
  }

  private settleSameAccount(input: SettlementInput): void {
    const account = this.requireAccount(input.buyerId);
    const reservedCash = safeProduct(input.buyLimitPriceMinor, input.quantity);
    const position = account.positions[input.symbol];
    if (
      account.cashFrozenMinor < reservedCash ||
      position.frozenQuantity < input.quantity
    ) {
      invariant();
    }

    account.cashFrozenMinor -= reservedCash;
    account.cashAvailableMinor += reservedCash;
    position.frozenQuantity -= input.quantity;
    position.availableQuantity += input.quantity;
    this.saveAccounts([account]);
  }

  private requireAccount(userId: string): AccountSnapshot {
    const account = this.readAccount(userId);
    if (account === undefined) {
      throw new DomainError("ACCOUNT_NOT_FOUND", 404, "账户不存在");
    }
    assertAccountInvariant(account);
    return account;
  }

  private saveAccounts(accounts: readonly AccountSnapshot[]): void {
    for (const account of accounts) {
      assertAccountInvariant(account);
    }
    const copies = accounts.map(cloneAccount);
    const store = accountStoreFor(this.state);
    for (const account of copies) {
      store.set(account.userId, account);
    }
  }

  private hasAccount(userId: string): boolean {
    return accountStoreFor(this.state).has(userId);
  }

  private readAccount(userId: string): AccountSnapshot | undefined {
    const account = accountStoreFor(this.state).get(userId);
    return account === undefined ? undefined : cloneAccount(account);
  }
}
