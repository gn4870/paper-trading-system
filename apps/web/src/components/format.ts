export const formatMinor = (value: number | bigint): string => {
  const minor = typeof value === "bigint" ? value : BigInt(Math.trunc(value));
  const sign = minor < 0n ? "-" : "";
  const absolute = minor < 0n ? -minor : minor;
  const major = absolute / 100n;
  const cents = (absolute % 100n).toString().padStart(2, "0");
  return `${sign}${major.toLocaleString("zh-CN")}.${cents}`;
};

export const formatPercentMovement = (changePercent: number): string => {
  if (changePercent > 0) return `+${changePercent.toFixed(2)}% 上涨`;
  if (changePercent < 0) return `${changePercent.toFixed(2)}% 下跌`;
  return "0.00% 平盘";
};

export const formatDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false
      }).format(date);
};
