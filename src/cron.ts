// 定期実行（Cloudflare Cron Triggers）からの LINE 通知。
import { listBookings, listInstructors } from "./db";
import { pushLine } from "./line";
import { calcSettlement, percent, yen } from "./lib/settlement";
import { formatJst, jstDateKey, jstMonthKey, jstToDate, monthLabel, monthRange, shiftMonth } from "./lib/time";
import type { Env } from "./types";

/** 毎日 20:00 JST：明日の予約リマインド＋実施完了の押し忘れ */
export async function dailyNotify(env: Env, now = new Date()) {
  const tomorrowKey = jstDateKey(new Date(now.getTime() + 86400_000));
  const tStart = jstToDate(tomorrowKey, "00:00");
  const tEnd = new Date(tStart.getTime() + 86400_000);

  for (const ins of await listInstructors(env)) {
    if (!ins.active || !ins.line_user_id) continue;

    const tomorrow = await listBookings(env, { instructorId: ins.id, from: tStart, to: tEnd, status: "reserved" });
    if (tomorrow.length > 0) {
      const lines = tomorrow.map((b) => `・${formatJst(new Date(b.start_at))} ${b.customer_name}様（${b.menu_name}）`);
      await pushLine(env, ins.line_user_id, `【明日の予約】\n${lines.join("\n")}`);
    }

    const pending = (
      await listBookings(env, {
        instructorId: ins.id,
        from: new Date(now.getTime() - 62 * 86400_000),
        to: now,
        status: "reserved",
      })
    ).filter((b) => new Date(b.end_at) <= now);
    if (pending.length > 0) {
      const lines = pending.map((b) => `・${formatJst(new Date(b.start_at))} ${b.customer_name}様`);
      await pushLine(
        env,
        ins.line_user_id,
        `【実施完了の入力をお願いします】\n${lines.join("\n")}\n\n${env.APP_URL}/`,
      );
    }
  }
}

/** 毎月1日 9:00 JST：前月の精算額のお知らせ */
export async function monthlyNotify(env: Env, now = new Date()) {
  const month = shiftMonth(jstMonthKey(now), -1);
  const { start, end } = monthRange(month);
  for (const ins of await listInstructors(env)) {
    if (!ins.line_user_id) continue;
    const rows = await listBookings(env, { instructorId: ins.id, from: start, to: end });
    const sum = calcSettlement(rows, ins.commission_rate_bp);
    if (!ins.active && sum.count === 0) continue;
    const unconfirmed = rows.filter((r) => r.status === "reserved").length;
    const text = [
      `【${monthLabel(month)}の精算額】`,
      `対象売上：${yen(sum.gross)}（${sum.count}件）`,
      `スペース利用料（${percent(sum.rateBp)}）：${yen(sum.fee)}`,
      unconfirmed > 0 ? `\n※実施完了が未入力の予約が${unconfirmed}件あり、まだ含まれていません。入力をお願いします。` : "",
      `\n明細：${env.APP_URL}/settlement?month=${month}`,
    ]
      .filter(Boolean)
      .join("\n");
    await pushLine(env, ins.line_user_id, text);
  }
}
