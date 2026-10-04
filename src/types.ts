export type Env = {
  DB: D1Database;
  APP_URL: string;
  ADMIN_EMAIL: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  SPACE_CALENDAR_ID?: string;
  GOOGLE_SA_EMAIL?: string;
  GOOGLE_SA_PRIVATE_KEY?: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  DEV_LOGIN?: string;
};

export type User = {
  id: number;
  email: string;
  name: string;
  role: "admin" | "instructor";
  commission_rate_bp: number;
  line_user_id: string | null;
  line_link_code: string | null;
  active: number;
};

export type AppEnv = { Bindings: Env; Variables: { user: User } };
