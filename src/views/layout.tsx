import type { Child } from "hono/jsx";
import type { User } from "../types";

const css = `
:root{--bg:#f7f6f3;--card:#fff;--text:#222;--muted:#6b6b6b;--line:#e4e2dc;--accent:#2f6f5e;--accent-weak:#e6f0ec;--warn:#b5532a;--warn-weak:#fbece5}
@media (prefers-color-scheme:dark){:root{--bg:#161817;--card:#1f2221;--text:#ececec;--muted:#a3a3a3;--line:#323634;--accent:#6cc0a6;--accent-weak:#203a33;--warn:#f0956c;--warn-weak:#3d261c}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif}
header{background:var(--card);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:1}
.bar{max-width:760px;margin:0 auto;padding:10px 16px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.brand{font-weight:700;text-decoration:none;color:var(--text);margin-right:auto}
nav a{color:var(--muted);text-decoration:none;font-size:14px;margin-left:12px}
nav a.on{color:var(--accent);font-weight:700}
main{max-width:760px;margin:0 auto;padding:16px}
h1{font-size:20px;margin:8px 0 16px}
h2{font-size:16px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin-bottom:10px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.grow{flex:1;min-width:0}
.muted{color:var(--muted);font-size:13px}
.tag{display:inline-block;font-size:12px;padding:1px 8px;border-radius:99px;background:var(--line)}
.tag.reserved{background:var(--accent-weak);color:var(--accent)}
.tag.billable{background:var(--accent);color:#fff}
.tag.warn{background:var(--warn-weak);color:var(--warn)}
form.inline{display:inline}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input,select,textarea{width:100%;font:inherit;padding:9px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--text)}
button,.btn{font:inherit;font-size:14px;padding:8px 14px;border-radius:8px;border:1px solid var(--accent);background:var(--accent);color:#fff;cursor:pointer;text-decoration:none;display:inline-block}
button.ghost,.btn.ghost{background:transparent;color:var(--accent)}
button.danger{background:transparent;border-color:var(--warn);color:var(--warn)}
.flash{padding:10px 14px;border-radius:8px;margin-bottom:12px;background:var(--accent-weak);color:var(--accent)}
.flash.err{background:var(--warn-weak);color:var(--warn)}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.big{font-size:26px;font-weight:700;font-variant-numeric:tabular-nums}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
@media (max-width:520px){.grid3{grid-template-columns:1fr}nav a{margin-left:8px}}
details summary{cursor:pointer;color:var(--accent);font-size:14px}
`;

const NAV = [
  { href: "/", label: "予定" },
  { href: "/slots/new", label: "枠を登録" },
  { href: "/history", label: "履歴" },
  { href: "/settlement", label: "精算" },
  { href: "/settings", label: "設定" },
];

export function Layout(props: {
  title: string;
  user?: User;
  path?: string;
  flash?: { msg: string; err?: boolean } | null;
  children?: Child;
}) {
  return (
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{`${props.title} | BANSO Pilates`}</title>
        <style dangerouslySetInnerHTML={{ __html: css }} />
      </head>
      <body>
        {props.user && (
          <header>
            <div class="bar">
              <a class="brand" href="/">BANSO Pilates</a>
              <nav>
                {NAV.map((n) => (
                  <a href={n.href} class={props.path === n.href ? "on" : ""}>
                    {n.label}
                  </a>
                ))}
              </nav>
            </div>
          </header>
        )}
        <main>
          {props.flash && <div class={props.flash.err ? "flash err" : "flash"}>{props.flash.msg}</div>}
          {props.children}
        </main>
      </body>
    </html>
  );
}
