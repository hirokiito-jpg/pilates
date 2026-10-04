import type { Env, User } from "./types";

export const ACTIVE_STATUSES_SQL = "('reserved','completed','cancelled_charged','no_show')";

export type SlotRow = {
  id: number;
  instructor_id: number;
  instructor_name: string;
  start_at: string;
  end_at: string;
  gcal_event_id: string | null;
  booking_id: number | null;
  customer_name: string | null;
  menu_name: string | null;
  price: number | null;
  status: string | null;
  payment_method: string | null;
  note: string | null;
};

export type BookingRow = {
  id: number;
  slot_id: number;
  instructor_id: number;
  instructor_name: string;
  customer_name: string;
  menu_name: string;
  price: number;
  status: string;
  payment_method: string | null;
  note: string | null;
  start_at: string;
  end_at: string;
  gcal_event_id: string | null;
};

export type Menu = { id: number; instructor_id: number; name: string; price: number; active: number };

/** 枠一覧（有効な予約があれば結合）。instructorId が null なら全員分 */
export async function listSlots(env: Env, instructorId: number | null, from: Date, to: Date) {
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.instructor_id, u.name AS instructor_name, s.start_at, s.end_at, s.gcal_event_id,
            b.id AS booking_id, b.customer_name, b.menu_name, b.price, b.status, b.payment_method, b.note
     FROM slots s
     JOIN users u ON u.id = s.instructor_id
     LEFT JOIN bookings b ON b.slot_id = s.id AND b.status IN ${ACTIVE_STATUSES_SQL}
     WHERE s.deleted_at IS NULL AND s.start_at >= ? AND s.start_at < ?
       AND (? IS NULL OR s.instructor_id = ?)
     ORDER BY s.start_at`,
  )
    .bind(from.toISOString(), to.toISOString(), instructorId, instructorId)
    .all<SlotRow>();
  return results;
}

/** 予約一覧（キャンセル含む全ステータス） */
export async function listBookings(
  env: Env,
  opts: { instructorId: number | null; from: Date; to: Date; status?: string },
) {
  const { results } = await env.DB.prepare(
    `SELECT b.*, u.name AS instructor_name, s.start_at, s.end_at, s.gcal_event_id
     FROM bookings b
     JOIN slots s ON s.id = b.slot_id
     JOIN users u ON u.id = b.instructor_id
     WHERE s.start_at >= ? AND s.start_at < ?
       AND (? IS NULL OR b.instructor_id = ?)
       AND (? IS NULL OR b.status = ?)
     ORDER BY s.start_at`,
  )
    .bind(
      opts.from.toISOString(),
      opts.to.toISOString(),
      opts.instructorId,
      opts.instructorId,
      opts.status ?? null,
      opts.status ?? null,
    )
    .all<BookingRow>();
  return results;
}

export async function getSlot(env: Env, id: number) {
  return env.DB.prepare(
    `SELECT s.id, s.instructor_id, u.name AS instructor_name, s.start_at, s.end_at, s.gcal_event_id,
            b.id AS booking_id, b.customer_name, b.menu_name, b.price, b.status, b.payment_method, b.note
     FROM slots s
     JOIN users u ON u.id = s.instructor_id
     LEFT JOIN bookings b ON b.slot_id = s.id AND b.status IN ${ACTIVE_STATUSES_SQL}
     WHERE s.id = ? AND s.deleted_at IS NULL`,
  )
    .bind(id)
    .first<SlotRow>();
}

export async function getBooking(env: Env, id: number) {
  return env.DB.prepare(
    `SELECT b.*, u.name AS instructor_name, s.start_at, s.end_at, s.gcal_event_id
     FROM bookings b JOIN slots s ON s.id = b.slot_id JOIN users u ON u.id = b.instructor_id
     WHERE b.id = ?`,
  )
    .bind(id)
    .first<BookingRow>();
}

/** 指定時間帯と重なる枠（全インストラクター分。スペースは1つなので重複不可） */
export async function overlappingSlots(env: Env, start: Date, end: Date) {
  const { results } = await env.DB.prepare(
    `SELECT id, start_at, end_at FROM slots
     WHERE deleted_at IS NULL AND start_at < ? AND end_at > ?`,
  )
    .bind(end.toISOString(), start.toISOString())
    .all<{ id: number; start_at: string; end_at: string }>();
  return results;
}

export async function listMenus(env: Env, instructorId: number, includeInactive = false) {
  const { results } = await env.DB.prepare(
    `SELECT * FROM menus WHERE instructor_id = ? AND (? = 1 OR active = 1) ORDER BY sort_order, id`,
  )
    .bind(instructorId, includeInactive ? 1 : 0)
    .all<Menu>();
  return results;
}

export async function listInstructors(env: Env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM users WHERE role = 'instructor' ORDER BY active DESC, id",
  ).all<User>();
  return results;
}

export async function getUser(env: Env, id: number) {
  return env.DB.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

/** インストラクター登録時の初期メニュー */
export const DEFAULT_MENUS = [
  { name: "パーソナル60分", price: 10000 },
  { name: "体験", price: 5000 },
];
