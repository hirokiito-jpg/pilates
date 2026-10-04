// LINE 公式アカウント（Messaging API）でのプッシュ通知。未設定なら何もしない。
import type { Env } from "./types";

export async function pushLine(env: Env, to: string | null, text: string) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN || !to) {
    console.log(`[LINE skipped] to=${to}\n${text}`);
    return;
  }
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ to, messages: [{ type: "text", text: text.slice(0, 5000) }] }),
  });
  if (!res.ok) console.error(`LINE push failed: ${res.status} ${await res.text()}`);
}

export async function replyLine(env: Env, replyToken: string, text: string) {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) return;
  await fetch("https://api.line.me/v2/bot/message/reply", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
}

/** Webhook の署名検証（x-line-signature = base64(HMAC-SHA256(channelSecret, body))） */
export async function verifyLineSignature(secret: string, body: string, signature: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, sig, new TextEncoder().encode(body));
}
