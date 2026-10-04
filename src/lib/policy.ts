// キャンセル規定と精算ルール。

export type BookingStatus =
  | "reserved"
  | "completed"
  | "cancelled_free"
  | "cancelled_charged"
  | "no_show";

export const STATUS_LABEL: Record<BookingStatus, string> = {
  reserved: "予約中",
  completed: "実施完了",
  cancelled_free: "キャンセル（無料）",
  cancelled_charged: "キャンセル（料金発生）",
  no_show: "無断キャンセル",
};

/** 精算対象となるステータス：実施完了・24時間以内のキャンセル・無断キャンセル */
export const BILLABLE_STATUSES: readonly BookingStatus[] = [
  "completed",
  "cancelled_charged",
  "no_show",
];

export function isBillable(status: string): boolean {
  return (BILLABLE_STATUSES as readonly string[]).includes(status);
}

export const FREE_CANCEL_HOURS = 24;

/** キャンセル時刻が開始の24時間前まで（ちょうど24時間前を含む）なら無料、それ以降は全額 */
export function cancellationStatus(start: Date, cancelledAt: Date): "cancelled_free" | "cancelled_charged" {
  const diff = start.getTime() - cancelledAt.getTime();
  return diff >= FREE_CANCEL_HOURS * 60 * 60 * 1000 ? "cancelled_free" : "cancelled_charged";
}

export const PAYMENT_METHODS = ["現金", "PayPay", "振込", "その他"] as const;
