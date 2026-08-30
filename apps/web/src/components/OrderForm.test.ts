import type { PlaceOrderRequest } from "@paper/shared";
import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";

import { ApiClientError } from "../api/http-client.js";
import OrderForm from "./OrderForm.vue";

describe("OrderForm", () => {
  it("prefills a buy with best ask and emits exact minor units", async () => {
    const wrapper = mount(OrderForm, {
      props: { symbol: "AAPL", bestBidMinor: 18_690, bestAskMinor: 18_700 }
    });
    await wrapper.get("[data-action=use-best-ask]").trigger("click");
    await wrapper.get("[name=quantity]").setValue("100");
    await wrapper.get("[data-action=buy]").trigger("click");
    expect(wrapper.emitted("submit")?.[0]?.[0]).toMatchObject({
      symbol: "AAPL",
      side: "BUY",
      limitPriceMinor: 18_700,
      quantity: 100
    });
    expect(
      (wrapper.emitted("submit")?.[0]?.[0] as PlaceOrderRequest).clientOrderId
    ).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("prefills a sell with best bid", async () => {
    const wrapper = mount(OrderForm, {
      props: { symbol: "MSFT", bestBidMinor: 42_599, bestAskMinor: 42_601 }
    });
    await wrapper.get("[data-action=use-best-bid]").trigger("click");
    await wrapper.get("[name=quantity]").setValue("2");
    await wrapper.get("[data-action=sell]").trigger("click");
    expect(wrapper.emitted("submit")?.[0]?.[0]).toMatchObject({
      symbol: "MSFT",
      side: "SELL",
      limitPriceMinor: 42_599,
      quantity: 2
    });
  });

  it.each(["0", "-1", "1.001", "1.", "abc"])(
    "rejects invalid limit price %s",
    async (price) => {
      const submitOrder =
        vi.fn<(request: PlaceOrderRequest) => Promise<void>>();
      const wrapper = mount(OrderForm, {
        props: {
          symbol: "AAPL",
          bestBidMinor: null,
          bestAskMinor: null,
          submitOrder
        }
      });
      await wrapper.get("[name=price]").setValue(price);
      await wrapper.get("[name=quantity]").setValue("1");
      await wrapper.get("[data-action=buy]").trigger("click");
      expect(submitOrder).not.toHaveBeenCalled();
      expect(wrapper.get("[role=alert]").text()).toContain("最多两位小数");
    }
  );

  it.each(["0", "-1", "1.5", "abc"])(
    "rejects invalid quantity %s",
    async (quantity) => {
      const submitOrder =
        vi.fn<(request: PlaceOrderRequest) => Promise<void>>();
      const wrapper = mount(OrderForm, {
        props: {
          symbol: "AAPL",
          bestBidMinor: null,
          bestAskMinor: null,
          submitOrder
        }
      });
      await wrapper.get("[name=price]").setValue("0.29");
      await wrapper.get("[name=quantity]").setValue(quantity);
      await wrapper.get("[data-action=buy]").trigger("click");
      expect(submitOrder).not.toHaveBeenCalled();
      expect(wrapper.get("[role=alert]").text()).toContain("正整数");
    }
  );

  it("converts decimal text without floating-point drift and shows estimated funds", async () => {
    const submitOrder = vi
      .fn<(request: PlaceOrderRequest) => Promise<void>>()
      .mockResolvedValue();
    const wrapper = mount(OrderForm, {
      props: {
        symbol: "AAPL",
        bestBidMinor: null,
        bestAskMinor: null,
        submitOrder
      }
    });
    await wrapper.get("[name=price]").setValue("0.29");
    await wrapper.get("[name=quantity]").setValue("3");
    expect(wrapper.get("[data-estimate=buy]").text()).toContain("0.87");
    await wrapper.get("[data-action=buy]").trigger("click");
    expect(submitOrder).toHaveBeenCalledWith(
      expect.objectContaining({ limitPriceMinor: 29, quantity: 3 })
    );
  });

  it("keeps values, translates API errors, and prevents duplicate submissions", async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const submitOrder = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectRequest = reject;
        })
    );
    const wrapper = mount(OrderForm, {
      props: {
        symbol: "AAPL",
        bestBidMinor: 18_690,
        bestAskMinor: 18_700,
        submitOrder
      }
    });
    await wrapper.get("[name=price]").setValue("187.00");
    await wrapper.get("[name=quantity]").setValue("100");
    await wrapper.get("[data-action=buy]").trigger("click");
    await wrapper.get("[data-action=buy]").trigger("click");
    expect(submitOrder).toHaveBeenCalledTimes(1);
    expect(
      wrapper.get("[data-action=buy]").attributes("disabled")
    ).toBeDefined();
    rejectRequest?.(
      new ApiClientError(
        409,
        "INSUFFICIENT_FUNDS",
        "server detail",
        "request-1"
      )
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(
      (wrapper.get("[name=price]").element as HTMLInputElement).value
    ).toBe("187.00");
    expect(
      (wrapper.get("[name=quantity]").element as HTMLInputElement).value
    ).toBe("100");
    expect(wrapper.get("[role=alert]").text()).toContain("可用资金不足");
  });

  it.each([
    new ApiClientError(0, "NETWORK_ERROR", "response lost"),
    new ApiClientError(503, "HTTP_ERROR", "gateway failed")
  ])(
    "reuses the clientOrderId after an uncertain result",
    async (uncertainError) => {
      const submitOrder = vi
        .fn()
        .mockRejectedValueOnce(uncertainError)
        .mockResolvedValueOnce(undefined);
      const wrapper = mount(OrderForm, {
        props: {
          symbol: "AAPL",
          bestBidMinor: null,
          bestAskMinor: null,
          submitOrder
        }
      });
      await wrapper.get("[name=price]").setValue("187.00");
      await wrapper.get("[name=quantity]").setValue("10");

      await wrapper.get("[data-action=buy]").trigger("click");
      await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(1));
      await wrapper.get("[data-action=buy]").trigger("click");
      await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(2));

      const first = submitOrder.mock.calls[0]![0] as PlaceOrderRequest;
      const retry = submitOrder.mock.calls[1]![0] as PlaceOrderRequest;
      expect(retry.clientOrderId).toBe(first.clientOrderId);
    }
  );

  it("uses a new clientOrderId when fields, side, or symbol change after uncertainty", async () => {
    const submitOrder = vi
      .fn()
      .mockRejectedValue(new ApiClientError(0, "NETWORK_ERROR", "lost"));
    const wrapper = mount(OrderForm, {
      props: {
        symbol: "AAPL",
        bestBidMinor: null,
        bestAskMinor: null,
        submitOrder
      }
    });
    await wrapper.get("[name=price]").setValue("187.00");
    await wrapper.get("[name=quantity]").setValue("10");
    await wrapper.get("[data-action=buy]").trigger("click");
    await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(1));

    await wrapper.get("[name=quantity]").setValue("11");
    await wrapper.get("[data-action=buy]").trigger("click");
    await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(2));
    await wrapper.get("[data-action=sell]").trigger("click");
    await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(3));
    await wrapper.setProps({ symbol: "MSFT" });
    await wrapper.get("[data-action=sell]").trigger("click");
    await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(4));

    const ids = submitOrder.mock.calls.map(
      ([request]) => (request as PlaceOrderRequest).clientOrderId
    );
    expect(new Set(ids).size).toBe(4);
  });

  it.each([409, 422])(
    "uses a new clientOrderId after an explicit %s rejection",
    async (status) => {
      const submitOrder = vi
        .fn()
        .mockRejectedValueOnce(
          new ApiClientError(status, "REJECTED", "rejected")
        )
        .mockResolvedValueOnce(undefined);
      const wrapper = mount(OrderForm, {
        props: {
          symbol: "AAPL",
          bestBidMinor: null,
          bestAskMinor: null,
          submitOrder
        }
      });
      await wrapper.get("[name=price]").setValue("187.00");
      await wrapper.get("[name=quantity]").setValue("10");
      await wrapper.get("[data-action=buy]").trigger("click");
      await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(1));
      await wrapper.get("[data-action=buy]").trigger("click");
      await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(2));

      const first = submitOrder.mock.calls[0]![0] as PlaceOrderRequest;
      const retry = submitOrder.mock.calls[1]![0] as PlaceOrderRequest;
      expect(retry.clientOrderId).not.toBe(first.clientOrderId);
    }
  );

  it("uses a new clientOrderId after a successful command", async () => {
    const submitOrder = vi.fn().mockResolvedValue(undefined);
    const wrapper = mount(OrderForm, {
      props: {
        symbol: "AAPL",
        bestBidMinor: null,
        bestAskMinor: null,
        submitOrder
      }
    });
    await wrapper.get("[name=price]").setValue("187.00");
    await wrapper.get("[name=quantity]").setValue("10");
    await wrapper.get("[data-action=buy]").trigger("click");
    await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(1));
    await wrapper.get("[data-action=buy]").trigger("click");
    await vi.waitFor(() => expect(submitOrder).toHaveBeenCalledTimes(2));

    const first = submitOrder.mock.calls[0]![0] as PlaceOrderRequest;
    const second = submitOrder.mock.calls[1]![0] as PlaceOrderRequest;
    expect(second.clientOrderId).not.toBe(first.clientOrderId);
  });
});
