import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";

test.describe.configure({ mode: "serial" });

test("registers and completes a buy then sell through live WebSocket state", async ({
  page
}) => {
  const username = `e2e_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

  await page.goto("/register");
  await page.getByLabel("用户名").fill(username);
  await page.getByLabel("密码").fill("safe-pass-123");
  await page.getByRole("button", { name: "创建账户" }).click();

  await expect(
    page.getByRole("heading", { name: "模拟证券交易终端" })
  ).toBeVisible();
  await expect(
    page.getByRole("status", { name: "WebSocket：实时连接正常" })
  ).toBeVisible();

  const aapl = page.getByRole("button", { name: /^AAPL\b/ });
  await expect(aapl).toContainText(/上涨|下跌|平盘/);
  await aapl.click();

  const bestAsk = page.getByRole("button", { name: /^最佳卖价/ });
  const bestBid = page.getByRole("button", { name: /^最佳买价/ });
  await expect(bestAsk).toBeEnabled();
  await expect(bestBid).toBeEnabled();

  await bestAsk.click();
  await page.getByLabel("数量（股）").fill("100");
  await page.getByRole("button", { name: "买入", exact: true }).click();

  await page.getByRole("tab", { name: "全部持仓" }).click();
  const holdingsTable = page.getByRole("table", { name: "全部持仓" });
  const aaplHolding = holdingsTable.getByRole("row", { name: /^AAPL\b/ });
  await expect(aaplHolding.getByRole("cell").nth(1)).toHaveText("100");
  await expect(aaplHolding.getByRole("cell").nth(3)).toHaveText("100");

  await bestBid.click();
  await page.getByRole("button", { name: "卖出", exact: true }).click();
  await expect(aaplHolding.getByRole("cell").nth(1)).toHaveText("0");

  await page.getByRole("tab", { name: /^最近成交/ }).click();
  const tradesTable = page.getByRole("table", { name: "最近成交" });
  await expect(
    tradesTable.getByRole("row").filter({ hasText: /AAPL.*卖出/ })
  ).toHaveCount(1);
  await expect(
    tradesTable.getByRole("row").filter({ hasText: /AAPL.*买入/ })
  ).toHaveCount(1);
});
