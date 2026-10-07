// スペース専用 Google カレンダーとの連携（サービスアカウント経由）。
// 環境変数が未設定のときは何もしない（ローカル開発・テスト用）。
import type { Env } from "./types";

type Busy = { start: Date; end: Date };

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
  const ignorable = (res.status === 404 || res.status === 410) && init.method !== "POST";
  if (!res.ok && !ignorable) {
    throw new CalendarError(res.status, await res.text());
  }
  return res;
}

/** スペースカレンダーの埋まっている時間帯 */
export async function getBusy(env: Env, from: Date, to: Date): Promise<Busy[]> {
  if (!calendarEnabled(env)) return [];
  const res = await gcalFetch(env, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      timeZone: "Asia/Tokyo",
      items: [{ id: env.SPACE_CALENDAR_ID }],
    }),
  });
  const json = (await res.json()) as {
    calendars: Record<string, { busy?: { start: string; end: string }[]; errors?: unknown[] }>;
  };
  const cal = json.calendars[env.SPACE_CALENDAR_ID!];
  if (!cal || cal.errors?.length) {
    throw new Error(`カレンダーを参照できません（共有設定を確認してください）: ${JSON.stringify(cal?.errors)}`);
  }
  return (cal.busy ?? []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) }));
}

export function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }) {
  return a.start < b.end && b.start < a.end;
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
