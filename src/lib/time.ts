// 日本時間（JST, UTC+9・サマータイムなし）と UTC の変換ユーティリティ。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** "2026-10-05" + "10:00"（JST）→ UTC の Date */
export function jstToDate(date: string, time: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m || !t) throw new Error(`invalid date/time: ${date} ${time}`);
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  return new Date(utc - JST_OFFSET_MS);
}

/** UTC の Date → JST の各要素 */
export function jstParts(d: Date) {
  const j = new Date(d.getTime() + JST_OFFSET_MS);
  return {
    year: j.getUTCFullYear(),
    month: j.getUTCMonth() + 1,
    day: j.getUTCDate(),
    hour: j.getUTCHours(),
    minute: j.getUTCMinutes(),
    weekday: j.getUTCDay(),
  };
}

const pad = (n: number) => String(n).padStart(2, "0");
const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** "2026-10-05" */
export function jstDateKey(d: Date): string {
  const p = jstParts(d);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

/** "2026-10" */
export function jstMonthKey(d: Date): string {
  const p = jstParts(d);
  return `${p.year}-${pad(p.month)}`;
}

/** "10/5(月) 10:00" */
export function formatJst(d: Date): string {
  const p = jstParts(d);
  return `${p.month}/${p.day}(${WEEKDAYS[p.weekday]}) ${pad(p.hour)}:${pad(p.minute)}`;
}

/** "10:00" */
export function formatJstTime(d: Date): string {
  const p = jstParts(d);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** "2026-10" → その月の JST 1日 0:00 〜 翌月 1日 0:00 を UTC で返す */
export function monthRange(month: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`invalid month: ${month}`);
  const y = +m[1];
  const mo = +m[2];
  const start = new Date(Date.UTC(y, mo - 1, 1) - JST_OFFSET_MS);
  const end = new Date(Date.UTC(y, mo, 1) - JST_OFFSET_MS);
  return { start, end };
}

/** "2026-10" → "2026-09"（delta = -1） */
export function shiftMonth(month: string, delta: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`invalid month: ${month}`);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

export function isValidMonth(s: string | undefined): s is string {
  return !!s && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
}

/**
 * JST の日付と開始〜終了時刻から、60分ごとの枠を切り出す。
 * 例: 10:00〜13:00 → [10:00-11:00, 11:00-12:00, 12:00-13:00]
 */
export function splitIntoSlots(date: string, from: string, to: string, minutes = 60) {
  const start = jstToDate(date, from);
  const end = jstToDate(date, to);
  const slots: { start: Date; end: Date }[] = [];
  for (let t = start.getTime(); t + minutes * 60_000 <= end.getTime(); t += minutes * 60_000) {
    slots.push({ start: new Date(t), end: new Date(t + minutes * 60_000) });
  }
  return slots;
}

/** "2026-09" → "2026年9月" */
export function monthLabel(month: string): string {
  const [y, m] = month.split("-");
  return `${y}年${Number(m)}月`;
}
