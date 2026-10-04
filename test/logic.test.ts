import { describe, expect, it } from "vitest";
import { cancellationStatus, isBillable } from "../src/lib/policy";
import { calcSettlement } from "../src/lib/settlement";
import { formatJst, jstMonthKey, jstToDate, monthRange, shiftMonth, splitIntoSlots } from "../src/lib/time";

describe("time (JST)", () => {
  it("JST の日時を UTC に変換する", () => {
    expect(jstToDate("2026-10-05", "10:00").toISOString()).toBe("2026-10-05T01:00:00.000Z");
    expect(jstToDate("2026-10-05", "08:00").toISOString()).toBe("2026-10-04T23:00:00.000Z");
  });

  it("表示は JST", () => {
    expect(formatJst(new Date("2026-10-04T23:00:00Z"))).toBe("10/5(月) 08:00");
  });

  it("月の範囲は JST の月初〜翌月初", () => {
    const { start, end } = monthRange("2026-12");
    expect(start.toISOString()).toBe("2026-11-30T15:00:00.000Z");
    expect(end.toISOString()).toBe("2026-12-31T15:00:00.000Z");
    // 1日 0:30 JST は当月、月末 23:30 JST も当月
    expect(jstMonthKey(new Date("2026-11-30T15:30:00Z"))).toBe("2026-12");
    expect(jstMonthKey(new Date("2026-12-31T14:30:00Z"))).toBe("2026-12");
  });

  it("月をまたいで前後に移動できる", () => {
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
  });

  it("時間帯を60分の枠に分割（端数は切り捨て）", () => {
    const slots = splitIntoSlots("2026-10-05", "10:00", "12:30");
    expect(slots.map((s) => s.start.toISOString())).toEqual([
      "2026-10-05T01:00:00.000Z",
      "2026-10-05T02:00:00.000Z",
    ]);
    expect(splitIntoSlots("2026-10-05", "10:00", "10:30")).toEqual([]);
  });
});

describe("キャンセル規定", () => {
  const start = new Date("2026-10-10T01:00:00Z"); // 10/10 10:00 JST
  it("ちょうど24時間前までは無料", () => {
    expect(cancellationStatus(start, new Date("2026-10-09T01:00:00Z"))).toBe("cancelled_free");
    expect(cancellationStatus(start, new Date("2026-10-08T12:00:00Z"))).toBe("cancelled_free");
  });
  it("24時間を切ったら全額", () => {
    expect(cancellationStatus(start, new Date("2026-10-09T01:00:01Z"))).toBe("cancelled_charged");
  });
  it("精算対象は実施完了・直前キャンセル・無断キャンセル", () => {
    expect(isBillable("completed")).toBe(true);
    expect(isBillable("cancelled_charged")).toBe(true);
    expect(isBillable("no_show")).toBe(true);
    expect(isBillable("reserved")).toBe(false);
    expect(isBillable("cancelled_free")).toBe(false);
  });
});

describe("月次精算", () => {
  it("対象売上 × 30%", () => {
    const r = calcSettlement(
      [
        { price: 10000, status: "completed" },
        { price: 10000, status: "completed" },
        { price: 10000, status: "cancelled_charged" },
        { price: 5000, status: "no_show" },
        { price: 10000, status: "cancelled_free" },
        { price: 10000, status: "reserved" },
      ],
      3000,
    );
    expect(r).toEqual({ count: 4, gross: 35000, rateBp: 3000, fee: 10500 });
  });
  it("1円未満は切り捨て", () => {
    expect(calcSettlement([{ price: 3333, status: "completed" }], 3000).fee).toBe(999);
  });
  it("対象なしは0円", () => {
    expect(calcSettlement([], 3000).fee).toBe(0);
  });
});
