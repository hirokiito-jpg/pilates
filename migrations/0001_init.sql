-- 日時はすべて UTC の ISO 8601 文字列（例: 2026-10-05T01:00:00.000Z）で保存する。
-- 金額はすべて税込の円（整数）。料率は basis point（3000 = 30%）。

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'instructor')),
  commission_rate_bp INTEGER NOT NULL DEFAULT 3000,
  line_user_id TEXT,
  line_link_code TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);

CREATE TABLE menus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instructor_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  active INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- インストラクターがスペースを使える枠（60分）。作成時にスペースカレンダーへ仮押さえを書き込む。
CREATE TABLE slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instructor_id INTEGER NOT NULL REFERENCES users(id),
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  gcal_event_id TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_slots_start ON slots(start_at);

-- 予約。メニュー名・金額は予約時点の値をコピーして保持する（後でメニュー料金を変えても過去分は変わらない）。
-- status:
--   reserved          予約中
--   completed         実施完了（精算対象）
--   cancelled_free    24時間前までのキャンセル（精算対象外）
--   cancelled_charged 24時間以内のキャンセル（全額・精算対象）
--   no_show           無断キャンセル（全額・精算対象）
CREATE TABLE bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slot_id INTEGER NOT NULL REFERENCES slots(id),
  instructor_id INTEGER NOT NULL REFERENCES users(id),
  customer_name TEXT NOT NULL,
  menu_name TEXT NOT NULL,
  price INTEGER NOT NULL CHECK (price >= 0),
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'completed', 'cancelled_free', 'cancelled_charged', 'no_show')),
  payment_method TEXT,
  note TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_bookings_slot ON bookings(slot_id);
-- 1つの枠に有効な予約は1件だけ（1対1）
CREATE UNIQUE INDEX idx_bookings_one_active
  ON bookings(slot_id) WHERE status IN ('reserved', 'completed', 'cancelled_charged', 'no_show');
