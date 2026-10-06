import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { authRoutes, requireLogin } from "./auth";
import { dailyNotify, monthlyNotify } from "./cron";
import { replyLine, verifyLineSignature } from "./line";
import { migrate } from "./migrate";
import { app as protectedRoutes } from "./routes";
import type { AppEnv, Env } from "./types";
import { Layout } from "./views/layout";

const app = new Hono<AppEnv>();

// 初回アクセス時にテーブルを自動作成・更新する
app.use("*", async (c, next) => {
  await migrate(c.env);
  await next();
});

// LINE Webhook（署名で検証するので CSRF・ログインの対象外）
app.post("/line/webhook", async (c) => {
  const body = await c.req.text();
  const sig = c.req.header("x-line-signature") ?? "";
  if (!c.env.LINE_CHANNEL_SECRET || !(await verifyLineSignature(c.env.LINE_CHANNEL_SECRET, body, sig))) {
    return c.text("invalid signature", 401);
  }
  const { events } = JSON.parse(body) as {
    events: { type: string; replyToken?: string; source?: { userId?: string }; message?: { type: string; text?: string } }[];
  };
  for (const ev of events) {
    if (ev.type !== "message" || ev.message?.type !== "text" || !ev.source?.userId || !ev.replyToken) continue;
    const code = ev.message.text?.trim() ?? "";
    if (!/^\d{6}$/.test(code)) continue;
    const res = await c.env.DB.prepare(
      "UPDATE users SET line_user_id = ?, line_link_code = NULL WHERE line_link_code = ? AND active = 1",
    )
      .bind(ev.source.userId, code)
      .run();
    await replyLine(
      c.env,
      ev.replyToken,
      res.meta.changes ? "連携が完了しました。予約のリマインドなどをお届けします。" : "連携コードが見つかりませんでした。",
    );
  }
  return c.text("ok");
});

app.use("*", csrf());

app.get("/login", (c) => {
  const errors: Record<string, string> = {
    forbidden: "このGoogleアカウントは登録されていません。管理者に登録を依頼してください。",
    state: "ログインをやり直してください。",
    token: "Googleとの通信に失敗しました。",
    unverified: "メールアドレスが確認できませんでした。",
  };
  const err = errors[c.req.query("error") ?? ""];
  return c.html(
    <Layout title="ログイン" flash={err ? { msg: err, err: true } : null}>
      <div class="card" style="max-width:380px;margin:15vh auto;text-align:center">
        <h1>BANSO Pilates</h1>
        <p class="muted">予約・精算管理</p>
        <p><a class="btn" href="/auth/google">Googleでログイン</a></p>
      </div>
    </Layout>,
  );
});

app.route("/", authRoutes);
app.use("*", requireLogin);
app.route("/", protectedRoutes);

export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext) {
    await migrate(env);
    if (event.cron === "0 11 * * *") ctx.waitUntil(dailyNotify(env));
    if (event.cron === "0 0 1 * *") ctx.waitUntil(monthlyNotify(env));
  },
};
