import { isBillable } from "./policy";

export type SettlementLine = { price: number; status: string };

/**
 * 月次精算：精算対象の売上合計（税込）× 料率。1円未満は切り捨て。
 * rateBp は basis point（3000 = 30%）。
 */
export function calcSettlement(lines: SettlementLine[], rateBp: number) {
  const billable = lines.filter((l) => isBillable(l.status));
  const gross = billable.reduce((sum, l) => sum + l.price, 0);
  const fee = Math.floor((gross * rateBp) / 10000);
  return { count: billable.length, gross, rateBp, fee };
}

export const yen = (n: number) => `${n.toLocaleString("ja-JP")}円`;
export const percent = (bp: number) => `${bp / 100}%`;
