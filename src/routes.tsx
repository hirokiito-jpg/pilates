import { Hono, type Context } from "hono";
import { requireAdmin } from "./auth";
import {
  DEFAULT_MENUS,
  getBooking,
  getSlot,
  getUser,
  listBookings,
  listInstructors,
  listMenus,
  listSlots,
  overlappingSlots,
  type BookingRow,
  type SlotRow,
} from "./db";
import { createEvent, deleteEvent, describeCalendarError, getBusy, overlaps, updateEventSummary } from "./gcal";
import {
  PAYMENT_METHODS,
  STATUS_LABEL,
  cancellationStatus,
  isBillable,
  type BookingStatus,
} from "./lib/policy";
import { calcSettlement, percent, yen } from "./lib/settlement";
import {
  formatJst,
  formatJstTime,
  isValidMonth,
  monthLabel,
  jstDateKey,
  jstMonthKey,
  monthRange,
  shiftMonth,
  splitIntoSlots,
} from "./lib/time";
import type { AppEnv, Env, User } from "./types";
import { Layout } from "./views/layout";

export const app = new Hono<AppEnv>();

// ---------- 共通ヘルパー ----------

const canManage = (user: User, instructorId: number) =>
  user.role === "admin" || user.id === instructorId;

/** 一覧に表示する対象インストラクター（管理者は全員＝null） */
const scope = (user: User) => (user.role === "admin" ? null : user.id);

function flashOf(c: Context<AppEnv>) {
  const msg = c.req.query("msg");
  return msg ? { msg, err: c.req.query("err") === "1" } : null;
}

function back(c: Context<AppEnv>, path: string, msg: string, err = false) {
  const sep = path.includes("?") ? "&" : "?";
  return c.redirect(`${path}${sep}msg=${encodeURIComponent(msg)}${err ? "&err=1" : ""}`);
}

function page(c: Context<AppEnv>, title: string, path: string, body: any) {
  return c.html(
    <Layout title={title} user={c.get("user")} path={path} flash={flashOf(c)}>
      {body}
    </Layout>,
  );
}

const calSummary = (instructor: string, b?: { customer_name: string; menu_name: string; status?: string }) => {
  if (!b) return `【仮押さえ】ピラティス（${instructor}）`;
  if (b.status === "cancelled_charged") return `【キャンセル・料金発生】ピラティス（${instructor}）`;
  if (b.status === "no_show") return `【無断キャンセル】ピラティス（${instructor}）`;
  if (b.status === "completed") return `【実施済】ピラティス（${instructor}）${b.customer_name}様`;
  return `【予約】ピラティス（${instructor}）${b.customer_name}様／${b.menu_name}`;
};

/** カレンダー連携の失敗で操作全体を止めないためのラッパー（DB が正） */
async function safeCal(task: Promise<unknown>) {
  try {
    await task;
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

function StatusTag({ status }: { status: string }) {
  const cls = status === "reserved" ? "reserved" : isBillable(status) ? "billable" : "warn";
  return <span class={`tag ${cls}`}>{STATUS_LABEL[status as BookingStatus] ?? status}</span>;
}

// ---------- 予定（トップ） ----------

app.get("/", async (c) => {
  const user = c.get("user");
  const now = new Date();
  const from = new Date(now.getTime() - 60 * 86400_000);
  const to = new Date(now.getTime() + 90 * 86400_000);
  const slots = await listSlots(c.env, scope(user), from, to);

  const pending = slots.filter((s) => s.status === "reserved" && new Date(s.end_at) <= now);
  const upcoming = slots.filter((s) => new Date(s.end_at) > now);
  const byDate = new Map<string, SlotRow[]>();
  for (const s of upcoming) {
    const key = jstDateKey(new Date(s.start_at));
    byDate.set(key, [...(byDate.get(key) ?? []), s]);
  }

  return page(
    c,
    "予定",
    "/",
    <>
      <div class="row">
        <h1 class="grow">予定</h1>
        <a class="btn" href="/slots/new">＋ 枠を登録</a>
      </div>

      {pending.length > 0 && (
        <>
          <h2>実施完了の入力待ち（{pending.length}件）</h2>
          {pending.map((s) => (
            <SlotCard slot={s} user={user} now={now} />
          ))}
        </>
      )}

      <h2>これからの枠</h2>
      {upcoming.length === 0 && (
        <p class="muted">登録済みの枠はありません。「枠を登録」から追加してください。</p>
      )}
      {[...byDate.entries()].map(([date, list]) => (
        <>
          <p class="muted" style="margin:16px 0 6px">{formatJst(new Date(list[0].start_at)).split(" ")[0]}</p>
          {list.map((s) => (
            <SlotCard slot={s} user={user} now={now} />
          ))}
        </>
      ))}
    </>,
  );
});

function SlotCard({ slot: s, user, now }: { slot: SlotRow; user: User; now: Date }) {
  const start = new Date(s.start_at);
  const started = start <= now;
  return (
    <div class="card">
      <div class="row">
        <div class="grow">
          <strong>
            {formatJst(start)}〜{formatJstTime(new Date(s.end_at))}
          </strong>{" "}
          {user.role === "admin" && <span class="muted">{s.instructor_name}</span>}
          <div>
            {s.booking_id ? (
              <>
                {s.customer_name}様／{s.menu_name}／{yen(s.price!)} <StatusTag status={s.status!} />
                {s.note && <div class="muted">{s.note}</div>}
              </>
            ) : (
              <span class="muted">空き枠</span>
            )}
          </div>
        </div>
        {!s.booking_id && !started && (
          <>
            <a class="btn" href={`/slots/${s.id}/book`}>予約を入れる</a>
            <form class="inline" method="post" action={`/slots/${s.id}/delete`}
              onsubmit="return confirm('この枠を削除しますか？')">
              <button class="ghost">削除</button>
            </form>
          </>
        )}
      </div>
      {s.status === "reserved" && (
        <div class="row" style="margin-top:10px">
          {started ? (
            <>
              <form class="inline row" method="post" action={`/bookings/${s.booking_id}/complete`}>
                <select name="payment_method" required style="width:auto">
                  <option value="">支払方法</option>
                  {PAYMENT_METHODS.map((m) => (
                    <option value={m}>{m}</option>
                  ))}
                </select>
                <button>実施完了</button>
              </form>
              <form class="inline" method="post" action={`/bookings/${s.booking_id}/noshow`}
                onsubmit="return confirm('無断キャンセル（全額・精算対象）にしますか？')">
                <button class="danger">無断キャンセル</button>
              </form>
            </>
          ) : (
            <form class="inline" method="post" action={`/bookings/${s.booking_id}/cancel`}
              onsubmit={`return confirm('${
                start.getTime() - now.getTime() >= 24 * 3600_000
                  ? "キャンセルしますか？（24時間前までなので料金は発生しません）"
                  : "24時間を切っているため、全額のキャンセル料金が発生し精算対象になります。キャンセルしますか？"
              }')`}>
              <button class="danger">キャンセル</button>
            </form>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- 枠の登録・削除 ----------

app.get("/slots/new", async (c) => {
  const user = c.get("user");
  const instructors = user.role === "admin" ? (await listInstructors(c.env)).filter((i) => i.active) : [];
  const today = jstDateKey(new Date());
  return page(
    c,
    "枠を登録",
    "/slots/new",
    <>
      <h1>枠を登録</h1>
      <div class="card">
        <p class="muted" style="margin-top:0">
          来られる時間帯を入れると、60分ごとの枠を作ります。スペースカレンダーで埋まっている時間はスキップします。
        </p>
        <form method="post" action="/slots">
          {user.role === "admin" && (
            <>
              <label>インストラクター</label>
              <select name="instructor_id" required>
                {instructors.map((i) => (
                  <option value={i.id}>{i.name}</option>
                ))}
              </select>
            </>
          )}
          <label>日付</label>
          <input type="date" name="date" min={today} value={c.req.query("date") ?? today} required />
          <div class="row">
            <div class="grow">
              <label>開始</label>
              <input type="time" name="from" step="1800" value="10:00" required />
            </div>
            <div class="grow">
              <label>終了</label>
              <input type="time" name="to" step="1800" value="11:00" required />
            </div>
          </div>
          <p style="margin-top:16px"><button>登録する</button></p>
        </form>
      </div>
    </>,
  );
});

app.post("/slots", async (c) => {
  const user = c.get("user");
  const form = await c.req.parseBody();
  const instructorId = user.role === "admin" ? Number(form.instructor_id) : user.id;
  const instructor = await getUser(c.env, instructorId);
  if (!instructor || instructor.role !== "instructor" || !canManage(user, instructorId)) {
    return back(c, "/slots/new", "インストラクターが不正です", true);
  }

  let candidates;
  try {
    candidates = splitIntoSlots(String(form.date), String(form.from), String(form.to));
  } catch {
    return back(c, "/slots/new", "日付・時刻の形式が正しくありません", true);
  }
  const now = new Date();
  candidates = candidates.filter((s) => s.start > now);
  if (candidates.length === 0) {
    return back(c, "/slots/new", "未来の時間で、60分以上の範囲を指定してください", true);
  }

  let busy;
  try {
    busy = await getBusy(c.env, candidates[0].start, candidates[candidates.length - 1].end);
  } catch (e) {
    console.error(e);
    return back(c, "/slots/new", `スペースカレンダーを確認できませんでした：${describeCalendarError(e)}`, true);
  }

  const created: string[] = [];
  const skipped: string[] = [];
  const failed: string[] = [];
  let failReason = "";
  for (const s of candidates) {
    const label = formatJstTime(s.start);
    const taken =
      busy.some((b) => overlaps(s, b)) || (await overlappingSlots(c.env, s.start, s.end)).length > 0;
    if (taken) {
      skipped.push(label);
      continue;
    }
    let eventId: string | null = null;
    try {
      eventId = await createEvent(c.env, { summary: calSummary(instructor.name), start: s.start, end: s.end });
    } catch (e) {
      console.error(e);
      failed.push(label);
      failReason = describeCalendarError(e);
      continue;
    }
    await c.env.DB.prepare(
      "INSERT INTO slots (instructor_id, start_at, end_at, gcal_event_id) VALUES (?, ?, ?, ?)",
    )
      .bind(instructorId, s.start.toISOString(), s.end.toISOString(), eventId)
      .run();
    created.push(label);
  }

  const msg = [
    created.length ? `${created.length}枠を登録しました（${created.join("・")}）` : "登録できる枠がありませんでした",
    skipped.length ? `スペースが埋まっているためスキップ：${skipped.join("・")}` : "",
    failed.length ? `カレンダーに書き込めませんでした：${failed.join("・")}（${failReason}）` : "",
  ]
    .filter(Boolean)
    .join("／");
  return back(c, created.length ? "/" : "/slots/new", msg, created.length === 0);
});

app.post("/slots/:id/delete", async (c) => {
  const user = c.get("user");
  const slot = await getSlot(c.env, Number(c.req.param("id")));
  if (!slot || !canManage(user, slot.instructor_id)) return back(c, "/", "枠が見つかりません", true);
  if (slot.booking_id) return back(c, "/", "予約が入っている枠は削除できません。先にキャンセルしてください", true);
  await safeCal(deleteEvent(c.env, slot.gcal_event_id));
  await c.env.DB.prepare("UPDATE slots SET deleted_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), slot.id)
    .run();
  return back(c, "/", `${formatJst(new Date(slot.start_at))} の枠を削除しました`);
});

// ---------- 予約 ----------

app.get("/slots/:id/book", async (c) => {
  const user = c.get("user");
  const slot = await getSlot(c.env, Number(c.req.param("id")));
  if (!slot || !canManage(user, slot.instructor_id)) return back(c, "/", "枠が見つかりません", true);
  if (slot.booking_id) return back(c, "/", "この枠はすでに予約済みです", true);
  const menus = await listMenus(c.env, slot.instructor_id);
  return page(
    c,
    "予約を入れる",
    "/",
    <>
      <h1>予約を入れる</h1>
      <div class="card">
        <p style="margin-top:0">
          <strong>
            {formatJst(new Date(slot.start_at))}〜{formatJstTime(new Date(slot.end_at))}
          </strong>{" "}
          <span class="muted">{slot.instructor_name}</span>
        </p>
        <form method="post" action={`/slots/${slot.id}/book`}>
          <label>お客さまのお名前</label>
          <input name="customer_name" required maxlength={50} placeholder="山田 花子" />
          <label>メニュー</label>
          <select name="menu_id" required>
            {menus.map((m) => (
              <option value={m.id}>
                {m.name}（{yen(m.price)}）
              </option>
            ))}
          </select>
          <label>メモ（任意）</label>
          <input name="note" maxlength={200} />
          <p class="muted">キャンセル規定：24時間前まで無料／それ以降・無断キャンセルは全額</p>
          <p><button>予約する</button> <a class="btn ghost" href="/">戻る</a></p>
        </form>
      </div>
    </>,
  );
});

app.post("/slots/:id/book", async (c) => {
  const user = c.get("user");
  const slot = await getSlot(c.env, Number(c.req.param("id")));
  if (!slot || !canManage(user, slot.instructor_id)) return back(c, "/", "枠が見つかりません", true);
  if (slot.booking_id) return back(c, "/", "この枠はすでに予約済みです", true);
  if (new Date(slot.start_at) <= new Date()) return back(c, "/", "開始時刻を過ぎた枠には予約できません", true);

  const form = await c.req.parseBody();
  const customer = String(form.customer_name ?? "").trim().slice(0, 50);
  const note = String(form.note ?? "").trim().slice(0, 200) || null;
  const menu = (await listMenus(c.env, slot.instructor_id)).find((m) => m.id === Number(form.menu_id));
  if (!customer || !menu) return back(c, `/slots/${slot.id}/book`, "お名前とメニューを入力してください", true);

  try {
    await c.env.DB.prepare(
      `INSERT INTO bookings (slot_id, instructor_id, customer_name, menu_name, price, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind(slot.id, slot.instructor_id, customer, menu.name, menu.price, note)
      .run();
  } catch {
    return back(c, "/", "この枠はすでに予約済みです", true);
  }
  await safeCal(
    updateEventSummary(c.env, slot.gcal_event_id,
      calSummary(slot.instructor_name, { customer_name: customer, menu_name: menu.name })),
  );
  return back(c, "/", `${formatJst(new Date(slot.start_at))} ${customer}様の予約を入れました`);
});

/** 予約の状態変更の共通処理 */
async function loadManagedBooking(c: Context<AppEnv>) {
  const b = await getBooking(c.env, Number(c.req.param("id")));
  if (!b || !canManage(c.get("user"), b.instructor_id)) return null;
  return b;
}

async function setStatus(env: Env, b: BookingRow, status: BookingStatus, extra: { payment_method?: string } = {}) {
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE bookings SET status = ?, payment_method = COALESCE(?, payment_method),
       completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
       cancelled_at = CASE WHEN ? IN ('cancelled_free','cancelled_charged','no_show') THEN ? ELSE cancelled_at END
     WHERE id = ? AND status = 'reserved'`,
  )
    .bind(status, extra.payment_method ?? null, status, now, status, now, b.id)
    .run();
  const summary =
    status === "cancelled_free"
      ? calSummary(b.instructor_name)
      : calSummary(b.instructor_name, { ...b, status });
  await safeCal(updateEventSummary(env, b.gcal_event_id, summary));
}

app.post("/bookings/:id/complete", async (c) => {
  const b = await loadManagedBooking(c);
  if (!b || b.status !== "reserved") return back(c, "/", "対象の予約が見つかりません", true);
  if (new Date(b.start_at) > new Date()) return back(c, "/", "開始前の予約は完了にできません", true);
  const method = String((await c.req.parseBody()).payment_method ?? "");
  if (!(PAYMENT_METHODS as readonly string[]).includes(method)) {
    return back(c, "/", "支払方法を選択してください", true);
  }
  await setStatus(c.env, b, "completed", { payment_method: method });
  return back(c, "/", `${b.customer_name}様のレッスンを実施完了にしました（${method}）`);
});

app.post("/bookings/:id/noshow", async (c) => {
  const b = await loadManagedBooking(c);
  if (!b || b.status !== "reserved") return back(c, "/", "対象の予約が見つかりません", true);
  if (new Date(b.start_at) > new Date()) return back(c, "/", "開始前は無断キャンセルにできません", true);
  await setStatus(c.env, b, "no_show");
  return back(c, "/", `${b.customer_name}様を無断キャンセル（精算対象）にしました`);
});

app.post("/bookings/:id/cancel", async (c) => {
  const b = await loadManagedBooking(c);
  if (!b || b.status !== "reserved") return back(c, "/", "対象の予約が見つかりません", true);
  const now = new Date();
  if (new Date(b.start_at) <= now) return back(c, "/", "開始後はキャンセルではなく「無断キャンセル」を選んでください", true);
  const status = cancellationStatus(new Date(b.start_at), now);
  await setStatus(c.env, b, status);
  return back(
    c,
    "/",
    status === "cancelled_free"
      ? `${b.customer_name}様の予約をキャンセルしました（無料）。枠は空きに戻りました`
      : `${b.customer_name}様の予約をキャンセルしました（24時間以内のため全額・精算対象）`,
  );
});

/** 入力ミスの取り消し：予約中に戻す（無料キャンセル後に別の予約が入っていれば不可） */
app.post("/bookings/:id/revert", async (c) => {
  const b = await loadManagedBooking(c);
  const to = String(c.req.query("to") ?? "/history");
  const safeTo = to.startsWith("/") && !to.startsWith("//") ? to : "/history";
  if (!b || b.status === "reserved") return back(c, safeTo, "対象の予約が見つかりません", true);
  try {
    await c.env.DB.prepare(
      "UPDATE bookings SET status = 'reserved', payment_method = NULL, completed_at = NULL, cancelled_at = NULL WHERE id = ?",
    )
      .bind(b.id)
      .run();
  } catch {
    return back(c, safeTo, "この枠には別の予約が入っているため戻せません", true);
  }
  await safeCal(updateEventSummary(c.env, b.gcal_event_id, calSummary(b.instructor_name, b)));
  return back(c, safeTo, `${b.customer_name}様の予約を「予約中」に戻しました`);
});

// ---------- 履歴 ----------

function MonthNav({ month, path }: { month: string; path: string }) {
  return (
    <div class="row" style="margin-bottom:12px">
      <a class="btn ghost" href={`${path}?month=${shiftMonth(month, -1)}`}>‹ 前月</a>
      <strong class="grow" style="text-align:center">{monthLabel(month)}</strong>
      <a class="btn ghost" href={`${path}?month=${shiftMonth(month, 1)}`}>翌月 ›</a>
    </div>
  );
}

app.get("/history", async (c) => {
  const user = c.get("user");
  const q = c.req.query("month");
  const month = isValidMonth(q) ? q : jstMonthKey(new Date());
  const { start, end } = monthRange(month);
  const rows = await listBookings(c.env, { instructorId: scope(user), from: start, to: end });
  const here = `/history?month=${month}`;
  return page(
    c,
    "履歴",
    "/history",
    <>
      <h1>予約履歴</h1>
      <MonthNav month={month} path="/history" />
      {rows.length === 0 && <p class="muted">この月の予約はありません。</p>}
      {rows.map((b) => (
        <div class="card">
          <div class="row">
            <div class="grow">
              <strong>{formatJst(new Date(b.start_at))}</strong>{" "}
              {user.role === "admin" && <span class="muted">{b.instructor_name}</span>}
              <div>
                {b.customer_name}様／{b.menu_name}／{yen(b.price)} <StatusTag status={b.status} />
                {b.payment_method && <span class="muted">（{b.payment_method}）</span>}
              </div>
            </div>
            {b.status !== "reserved" && (
              <form class="inline" method="post" action={`/bookings/${b.id}/revert?to=${encodeURIComponent(here)}`}
                onsubmit="return confirm('「予約中」に戻しますか？（入力ミスの修正用）')">
                <button class="ghost">予約中に戻す</button>
              </form>
            )}
          </div>
        </div>
      ))}
    </>,
  );
});

// ---------- 精算 ----------

app.get("/settlement", async (c) => {
  const user = c.get("user");
  const q = c.req.query("month");
  const month = isValidMonth(q) ? q : jstMonthKey(new Date());
  const { start, end } = monthRange(month);
  const instructors =
    user.role === "admin" ? await listInstructors(c.env) : [user];
  const rows = await listBookings(c.env, { instructorId: scope(user), from: start, to: end });

  const sections = instructors
    .map((ins) => {
      const mine = rows.filter((r) => r.instructor_id === ins.id);
      return {
        ins,
        lines: mine.filter((r) => isBillable(r.status)),
        unconfirmed: mine.filter((r) => r.status === "reserved" && new Date(r.end_at) <= new Date()),
        sum: calcSettlement(mine, ins.commission_rate_bp),
      };
    })
    .filter((s) => user.role !== "admin" || s.ins.active || s.lines.length > 0);

  const total = sections.reduce((n, s) => n + s.sum.fee, 0);

  return page(
    c,
    "精算",
    "/settlement",
    <>
      <h1>月次精算</h1>
      <MonthNav month={month} path="/settlement" />
      <p class="muted">
        精算対象：実施完了・24時間以内のキャンセル・無断キャンセル（税込金額 × 料率、1円未満切り捨て）。
        レッスン日が属する月で集計します。
      </p>
      {user.role === "admin" && sections.length > 1 && (
        <div class="card">
          <div class="muted">スペース利用料 合計</div>
          <div class="big">{yen(total)}</div>
        </div>
      )}
      {sections.map(({ ins, lines, unconfirmed, sum }) => (
        <div class="card">
          <h2 style="margin-top:0">{ins.name}</h2>
          <div class="grid3">
            <div>
              <div class="muted">対象売上（{sum.count}件）</div>
              <div class="big">{yen(sum.gross)}</div>
            </div>
            <div>
              <div class="muted">料率</div>
              <div class="big">{percent(sum.rateBp)}</div>
            </div>
            <div>
              <div class="muted">スペース利用料</div>
              <div class="big">{yen(sum.fee)}</div>
            </div>
          </div>
          {unconfirmed.length > 0 && (
            <p class="flash err" style="margin-top:12px">
              実施完了が未入力の予約が{unconfirmed.length}件あります（まだ精算に含まれていません）
            </p>
          )}
          {lines.length > 0 && (
            <details style="margin-top:10px">
              <summary>明細を見る</summary>
              <table>
                <thead>
                  <tr><th>日時</th><th>お客さま</th><th>区分</th><th class="num">金額</th></tr>
                </thead>
                <tbody>
                  {lines.map((l) => (
                    <tr>
                      <td>{formatJst(new Date(l.start_at))}</td>
                      <td>{l.customer_name}様<div class="muted">{l.menu_name}</div></td>
                      <td><StatusTag status={l.status} /></td>
                      <td class="num">{yen(l.price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </details>
          )}
        </div>
      ))}
    </>,
  );
});

// ---------- 設定（メニュー・LINE連携・インストラクター管理） ----------

app.get("/settings", async (c) => {
  const user = c.get("user");
  const menus = user.role === "instructor" ? await listMenus(c.env, user.id, true) : [];
  const instructors = user.role === "admin" ? await listInstructors(c.env) : [];
  return page(
    c,
    "設定",
    "/settings",
    <>
      <h1>設定</h1>
      <div class="card">
        <div class="row">
          <div class="grow">
            <strong>{user.name}</strong>
            <div class="muted">{user.email}（{user.role === "admin" ? "管理者" : "インストラクター"}）</div>
          </div>
          <form class="inline" method="post" action="/logout"><button class="ghost">ログアウト</button></form>
        </div>
      </div>

      {user.role === "instructor" && (
        <>
          <h2>LINE通知</h2>
          <div class="card">
            {user.line_user_id ? (
              <p style="margin:0">連携済みです。前日リマインド・実施完了の押し忘れ・月次の精算額をLINEでお知らせします。</p>
            ) : user.line_link_code ? (
              <p style="margin:0">
                LINE公式アカウントを友だち追加し、トークで次の数字を送ってください：
                <span class="big" style="display:block;letter-spacing:4px">{user.line_link_code}</span>
              </p>
            ) : (
              <form method="post" action="/settings/line-code">
                <p style="margin-top:0">LINEで通知を受け取るには連携が必要です。</p>
                <button>連携コードを発行</button>
              </form>
            )}
          </div>

          <h2>メニューと料金（税込）</h2>
          {menus.map((m) => (
            <form class="card row" method="post" action={`/menus/${m.id}`}>
              <input class="grow" name="name" value={m.name} required style="flex:2" />
              <input name="price" type="number" min={0} step={100} value={m.price} required style="width:110px" />
              <label class="row" style="margin:0;width:auto">
                <input type="checkbox" name="active" value="1" checked={!!m.active} style="width:auto" />
                表示
              </label>
              <button class="ghost">保存</button>
            </form>
          ))}
          <form class="card row" method="post" action="/menus">
            <input class="grow" name="name" placeholder="新しいメニュー名" required style="flex:2" />
            <input name="price" type="number" min={0} step={100} placeholder="金額" required style="width:110px" />
            <button>追加</button>
          </form>
          <p class="muted">料金を変えても、すでに入っている予約の金額は変わりません。</p>
        </>
      )}

      {user.role === "admin" && (
        <>
          <h2>インストラクター</h2>
          {instructors.map((i) => (
            <form class="card row" method="post" action={`/admin/instructors/${i.id}`}>
              <div class="grow">
                <strong>{i.name}</strong>
                <div class="muted">{i.email}{i.line_user_id ? "・LINE連携済" : "・LINE未連携"}</div>
              </div>
              <label class="row" style="margin:0;width:auto">
                料率
                <input name="rate" type="number" min={0} max={100} step={0.1}
                  value={i.commission_rate_bp / 100} style="width:80px" />%
              </label>
              <label class="row" style="margin:0;width:auto">
                <input type="checkbox" name="active" value="1" checked={!!i.active} style="width:auto" />
                有効
              </label>
              <button class="ghost">保存</button>
            </form>
          ))}
          <form class="card" method="post" action="/admin/instructors">
            <strong>インストラクターを追加</strong>
            <label>お名前</label>
            <input name="name" required />
            <label>Googleアカウントのメールアドレス（ログインに使用）</label>
            <input name="email" type="email" required />
            <label>料率（%）</label>
            <input name="rate" type="number" min={0} max={100} step={0.1} value={30} required />
            <p><button>追加</button></p>
          </form>
        </>
      )}
    </>,
  );
});

app.post("/settings/line-code", async (c) => {
  const user = c.get("user");
  const code = String(100000 + (crypto.getRandomValues(new Uint32Array(1))[0] % 900000));
  await c.env.DB.prepare("UPDATE users SET line_link_code = ? WHERE id = ?").bind(code, user.id).run();
  return c.redirect("/settings");
});

const parseYen = (v: unknown) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : null;
};

app.post("/menus", async (c) => {
  const user = c.get("user");
  if (user.role !== "instructor") return c.text("権限がありません", 403);
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim().slice(0, 50);
  const price = parseYen(form.price);
  if (!name || price === null) return back(c, "/settings", "メニュー名と金額を正しく入力してください", true);
  await c.env.DB.prepare("INSERT INTO menus (instructor_id, name, price, sort_order) VALUES (?, ?, ?, 100)")
    .bind(user.id, name, price)
    .run();
  return back(c, "/settings", `メニュー「${name}」を追加しました`);
});

app.post("/menus/:id", async (c) => {
  const user = c.get("user");
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim().slice(0, 50);
  const price = parseYen(form.price);
  if (!name || price === null) return back(c, "/settings", "メニュー名と金額を正しく入力してください", true);
  const res = await c.env.DB.prepare(
    "UPDATE menus SET name = ?, price = ?, active = ? WHERE id = ? AND instructor_id = ?",
  )
    .bind(name, price, form.active ? 1 : 0, Number(c.req.param("id")), user.id)
    .run();
  if (!res.meta.changes) return back(c, "/settings", "メニューが見つかりません", true);
  return back(c, "/settings", `メニュー「${name}」を保存しました`);
});

const parseRate = (v: unknown) => {
  const n = Math.round(Number(v) * 100);
  return Number.isFinite(n) && n >= 0 && n <= 10000 ? n : null;
};

app.post("/admin/instructors", requireAdmin, async (c) => {
  const form = await c.req.parseBody();
  const name = String(form.name ?? "").trim().slice(0, 50);
  const email = String(form.email ?? "").trim().toLowerCase();
  const rate = parseRate(form.rate);
  if (!name || !/^[^@\s]+@[^@\s]+$/.test(email) || rate === null) {
    return back(c, "/settings", "入力内容を確認してください", true);
  }
  const ins = await c.env.DB.prepare(
    "INSERT INTO users (email, name, role, commission_rate_bp) VALUES (?, ?, 'instructor', ?) ON CONFLICT(email) DO NOTHING RETURNING id",
  )
    .bind(email, name, rate)
    .first<{ id: number }>();
  if (!ins) return back(c, "/settings", "このメールアドレスはすでに登録されています", true);
  await c.env.DB.batch(
    DEFAULT_MENUS.map((m, i) =>
      c.env.DB.prepare("INSERT INTO menus (instructor_id, name, price, sort_order) VALUES (?, ?, ?, ?)")
        .bind(ins.id, m.name, m.price, i),
    ),
  );
  return back(c, "/settings", `${name}さんを追加しました（初期メニュー：パーソナル60分・体験）`);
});

app.post("/admin/instructors/:id", requireAdmin, async (c) => {
  const form = await c.req.parseBody();
  const rate = parseRate(form.rate);
  if (rate === null) return back(c, "/settings", "料率を正しく入力してください", true);
  await c.env.DB.prepare(
    "UPDATE users SET commission_rate_bp = ?, active = ? WHERE id = ? AND role = 'instructor'",
  )
    .bind(rate, form.active ? 1 : 0, Number(c.req.param("id")))
    .run();
  return back(c, "/settings", "インストラクター情報を保存しました");
});
