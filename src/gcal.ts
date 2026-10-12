// スペース専用 Google カレンダーとの連携（サービスアカウント経由）。
// 環境変数が未設定のときは何もしない（ローカル開発・テスト用）。
import type { CalEvent } from "./lib/conflicts";
import { jstToDate } from "./lib/time";
import type { Env } from "./types";

/** このシステムが書き込んだ予定に付ける目印 */
const APP_TAG = "banso-pilates";

export function calendarEnabled(env: Env): boolean {
  return !!(env.SPACE_CALENDAR_ID && env.GOOGLE_SA_EMAIL && env.GOOGLE_SA_PRIVATE_KEY);
}

const b64url = (data: ArrayBuffer | Uint8Array | string) => {
  const bytes =
    typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

export class CalendarError extends Error {
  constructor(public status: number, public body: string) {
    super(`Google Calendar error: ${status} ${body}`);
  }
}

/** 画面に出すための、原因の分かる短い説明（秘密情報は含まない） */
export function describeCalendarError(e: unknown): string {
  if (e instanceof CalendarError) {
    if (e.status === 403 && /writer access|forbidden|requiredAccessLevel/i.test(e.body)) {
      return "カレンダーの共有権限が「予定の変更」になっていません";
    }
    if (e.status === 404) return "カレンダーが見つかりません（カレンダーIDを確認してください）";
    if (e.status === 403 && /accessNotConfigured|has not been used|disabled/i.test(e.body)) {
      return "Google Calendar API が有効になっていません";
    }
    return `Googleカレンダーのエラー（${e.status}）`;
  }
  const msg = e instanceof Error ? e.message : String(e);
  if (/Google token error/.test(msg)) return "Googleへの認証に失敗しました（サービスアカウントの鍵を確認してください）";
  return "Googleカレンダーとの通信に失敗しました";
}

let cachedToken: { token: string; exp: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const pem = env.GOOGLE_SA_PRIVATE_KEY!.replace(/\\n/g, "\n");
  const der = Uint8Array.from(
    atob(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "")),
    (c) => c.charCodeAt(0),
  );
  const key = await crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: env.GOOGLE_SA_EMAIL,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(`${header}.${claim}`),
  );
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claim}.${b64url(sig)}`,
    }),
  });
  if (!res.ok) throw new Error(`Google token error: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { token: json.access_token, exp: now + json.expires_in };
  return json.access_token;
}

async function gcalFetch(env: Env, path: string, init: RequestInit = {}) {
  const res = await fetch(`https://www.googleapis.com/calendar/v3${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await accessToken(env)}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  // 削除済みの予定への削除・更新（404/410）は無視してよい
  const ignorable =
    (res.status === 404 || res.status === 410) && (init.method === "DELETE" || init.method === "PATCH");
  if (!res.ok && !ignorable) {
    throw new CalendarError(res.status, await res.text());
  }
  return res;
}

type ApiEvent = {
  id: string;
  status?: string;
  transparency?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  creator?: { email?: string };
  extendedProperties?: { private?: Record<string, string> };
};

const toDate = (t?: { dateTime?: string; date?: string }) =>
  t?.dateTime ? new Date(t.dateTime) : t?.date ? jstToDate(t.date, "00:00") : null;

/** スペースカレンダーの予定一覧（「空き」に設定された予定とキャンセル済みは除く） */
export async function listEvents(env: Env, from: Date, to: Date): Promise<CalEvent[]> {
  if (!calendarEnabled(env)) return [];
  const params = new URLSearchParams({
    timeMin: from.toISOString(),
    timeMax: to.toISOString(),
    singleEvents: "true",
    maxResults: "250",
  });
  const res = await gcalFetch(env, `${calPath(env)}?${params}`);
  const json = (await res.json()) as { items?: ApiEvent[] };
  const events: CalEvent[] = [];
  for (const e of json.items ?? []) {
    if (e.status === "cancelled" || e.transparency === "transparent") continue;
    const start = toDate(e.start);
    const end = toDate(e.end);
    if (!start || !end) continue;
    const fromApp =
      e.extendedProperties?.private?.app === APP_TAG ||
      (!!env.GOOGLE_SA_EMAIL && e.creator?.email === env.GOOGLE_SA_EMAIL);
    events.push({ id: e.id, start, end, fromApp });
  }
  return events;
}

const calPath = (env: Env) => `/calendars/${encodeURIComponent(env.SPACE_CALENDAR_ID!)}/events`;

export async function createEvent(
  env: Env,
  ev: { summary: string; description?: string; start: Date; end: Date },
): Promise<string | null> {
  if (!calendarEnabled(env)) return null;
  const res = await gcalFetch(env, calPath(env), {
    method: "POST",
    body: JSON.stringify({
      summary: ev.summary,
      description: ev.description,
      start: { dateTime: ev.start.toISOString(), timeZone: "Asia/Tokyo" },
      end: { dateTime: ev.end.toISOString(), timeZone: "Asia/Tokyo" },
      extendedProperties: { private: { app: APP_TAG } },
    }),
  });
  return ((await res.json()) as { id: string }).id;
}

export async function updateEventSummary(
  env: Env,
  eventId: string | null,
  summary: string,
  description?: string,
) {
  if (!calendarEnabled(env) || !eventId) return;
  await gcalFetch(env, `${calPath(env)}/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    body: JSON.stringify({ summary, description: description ?? "" }),
  });
}

export async function deleteEvent(env: Env, eventId: string | null) {
  if (!calendarEnabled(env) || !eventId) return;
  await gcalFetch(env, `${calPath(env)}/${encodeURIComponent(eventId)}`, { method: "DELETE" });
}
