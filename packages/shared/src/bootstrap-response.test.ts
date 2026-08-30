import { describe, expect, it } from "vitest";
import type { BootstrapResponse } from "./index.js";

describe("BootstrapResponse", () => {
  it("represents the complete bootstrap snapshot", () => {
    const response: BootstrapResponse = {
      user: { id: "user-1", username: "trader_01" },
      account: {
        userId: "user-1",
        cashAvailableMinor: 100_000_000,
        cashFrozenMinor: 0,
        positions: {
          AAPL: { availableQuantity: 0, frozenQuantity: 0 },
          MSFT: { availableQuantity: 0, frozenQuantity: 0 },
          TSLA: { availableQuantity: 0, frozenQuantity: 0 }
        }
      },
      stocks: [],
      orders: [],
      trades: [],
      stateVersion: 7
    };

    expect(response.stateVersion).toBe(7);
  });
});
