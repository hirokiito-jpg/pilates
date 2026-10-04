// Google アカウントでのログイン（OAuth 2.0 / OpenID Connect）とセッション管理。
// 登録済みのメールアドレス（管理者・インストラクター）だけがログインできる。
import { Hono, type Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { AppEnv, Env, User } from "./types";

const SESSION_COOKIE = "sid";
const STATE_COOKIE = "oauth_state";
const SESSION_DAYS = 30;

const randomId = () => {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
};

const secure = (env: Env) => env.APP_URL.startsWith("https://");

async function startSession(c: Context<AppEnv>, userId: number) {
  const id = randomId();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await c.env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(id, userId, expires.toISOString())
    .run();
  setCookie(c, SESSION_COOKIE, id, {
    httpOnly: true,
    secure: secure(c.env),
    sameSite: "Lax",
    path: "/",
    expires,
  });
}

/** 初回ログイン時、ADMIN_EMAIL のユーザーを管理者として自動作成する */
async function findOrBootstrapUser(env: Env, email: string, name: string): Promise<User | null> {
  const found = await env.DB.prepare("SELECT * FROM users WHERE email = ? AND active = 1")
    .bind(email)
    .first<User>();
  if (found) return found;
  if (email.toLowerCase() !== env.ADMIN_EMAIL.toLowerCase()) return null;
  return env.DB.prepare("INSERT INTO users (email, name, role) VALUES (?, ?, 'admin') RETURNING *")
    .bind(email, name || email)
    .first<User>();
}

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/auth/google", (c) => {
  if (!c.env.GOOGLE_CLIENT_ID) return c.text("GOOGLE_CLIENT_ID が未設定です", 500);
  const state = randomId();
  setCookie(c, STATE_COOKIE, state, {
    httpOnly: true,
    secure: secure(c.env),
    sameSite: "Lax",
    path: "/",
    maxAge: 600,
  });
  const params = new URLSearchParams({
    client_id: c.env.GOOGLE_CLIENT_ID,
    redirect_uri: `${c.env.APP_URL}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    prompt: "select_account",
  });
  return c.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
});

authRoutes.get("/auth/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  const saved = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/" });
  if (!code || !state || state !== saved) return c.redirect("/login?error=state");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: c.env.GOOGLE_CLIENT_ID!,
      client_secret: c.env.GOOGLE_CLIENT_SECRET!,
      redirect_uri: `${c.env.APP_URL}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) return c.redirect("/login?error=token");
  const { id_token } = (await res.json()) as { id_token: string };
  // Google のトークンエンドポイントから TLS で直接受け取った ID トークンなので、署名検証は省略できる（OIDC Core 3.1.3.7）
  const payload = JSON.parse(
    new TextDecoder().decode(
      Uint8Array.from(atob(id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")), (ch) =>
        ch.charCodeAt(0),
      ),
    ),
  ) as { email: string; email_verified: boolean; name?: string; aud: string };
  if (!payload.email_verified || payload.aud !== c.env.GOOGLE_CLIENT_ID) {
    return c.redirect("/login?error=unverified");
  }

  const user = await findOrBootstrapUser(c.env, payload.email, payload.name ?? "");
  if (!user) return c.redirect("/login?error=forbidden");
  await startSession(c, user.id);
  return c.redirect("/");
});

// ローカル開発専用：DEV_LOGIN=1 のときだけ Google を通さずにログインできる（本番では絶対に設定しない）
authRoutes.get("/dev-login", async (c) => {
  if (c.env.DEV_LOGIN !== "1" || !c.env.APP_URL.startsWith("http://localhost")) return c.notFound();
  const email = c.req.query("email") ?? c.env.ADMIN_EMAIL;
  const user = await findOrBootstrapUser(c.env, email, email);
  if (!user) return c.text("未登録のメールアドレスです", 403);
  await startSession(c, user.id);
  return c.redirect("/");
});

authRoutes.post("/logout", async (c) => {
  const sid = getCookie(c, SESSION_COOKIE);
  if (sid) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(sid).run();
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.redirect("/login");
});

export const requireLogin = createMiddleware<AppEnv>(async (c, next) => {
  const sid = getCookie(c, SESSION_COOKIE);
  const user = sid
    ? await c.env.DB.prepare(
        `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.id = ? AND s.expires_at > ? AND u.active = 1`,
      )
        .bind(sid, new Date().toISOString())
        .first<User>()
    : null;
  if (!user) return c.redirect("/login");
  c.set("user", user);
  await next();
});

export const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("user").role !== "admin") return c.text("権限がありません", 403);
  await next();
});
