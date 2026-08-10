import { Hono } from "hono";
import type { SqliteEventStore } from "@codebridge/work-items";

export interface WebWorkbenchWorkflow {
  id: string;
  name: string;
}

export interface WebWorkbenchAgent {
  id: string;
  name: string;
  status?: string;
  models?: string[];
}

export interface WebWorkbenchOptions {
  store: SqliteEventStore;
  token: string;
  agents?: string[];
  agentProfiles?: WebWorkbenchAgent[];
  workflows?: WebWorkbenchWorkflow[];
}

const BUILTIN_AGENT_ICONS: Record<string, string> = {
  codex: `<svg data-agent-icon="codex" aria-hidden="true" viewBox="0 0 2406 2406"><path d="M1 578.4C1 259.5 259.5 1 578.4 1h1249.1c319 0 577.5 258.5 577.5 577.4V2406H578.4C259.5 2406 1 2147.5 1 1828.6V578.4z" fill="#74aa9c"/><path id="codex-mark" d="M1107.3 299.1c-197.999 0-373.9 127.3-435.2 315.3L650 743.5v427.9c0 21.4 11 40.4 29.4 51.4l344.5 198.515V833.3h.1v-27.9L1372.7 604c33.715-19.52 70.44-32.857 108.47-39.828L1447.6 450.3C1361 353.5 1237.1 298.5 1107.3 299.1zm0 117.5-.6.6c79.699 0 156.3 27.5 217.6 78.4-2.5 1.2-7.4 4.3-11 6.1L952.8 709.3c-18.4 10.4-29.4 30-29.4 51.4V1248l-155.1-89.4V755.8c-.1-187.099 151.601-338.9 339-339.2z" fill="#fff"/><use href="#codex-mark" transform="rotate(60 1203 1203)"/><use href="#codex-mark" transform="rotate(120 1203 1203)"/><use href="#codex-mark" transform="rotate(180 1203 1203)"/><use href="#codex-mark" transform="rotate(240 1203 1203)"/><use href="#codex-mark" transform="rotate(300 1203 1203)"/></svg>`,
  pi: `<svg data-agent-icon="pi" aria-hidden="true" viewBox="0 0 800 800"><path fill="currentColor" fill-rule="evenodd" d="M165.29 165.29h352.07V400H400v117.36H282.65v117.36H165.29zm117.36 117.36V400H400V282.65z"/><path fill="currentColor" d="M517.36 400h117.36v234.72H517.36z"/></svg>`,
  cursor: `<svg data-agent-icon="cursor" aria-hidden="true" viewBox="0 0 24 24"><path fill="currentColor" d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.23.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/></svg>`,
  claude: `<svg data-agent-icon="claude" aria-hidden="true" viewBox="0 0 24 24"><path fill="#D97757" d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>`,
};

function toJavaScriptString(value: string): string {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/\r?\n/g, " ")}'`;
}

/**
 * A dependency-free local web surface. It deliberately uses the same HTTP
 * contracts as Feishu/Telegram instead of creating a second conversation path.
 */
export function createWebWorkbenchApp(options: WebWorkbenchOptions) {
  const app = new Hono();
  app.get("/", (c) => c.html(renderWorkbench(options)));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

function renderWorkbench(options: WebWorkbenchOptions): string {
  const agents = options.agents ?? [];
  const agentProfiles: WebWorkbenchAgent[] = options.agentProfiles ?? agents.map((id) => ({ id, name: id }));
  const workflows = options.workflows ?? [];
  const token = JSON.stringify(options.token).replace(/</g, "\\u003c");
  const models = [...new Set(agentProfiles.flatMap((agent) => agent.models ?? []))];
  const modelOptions = `<option value="">模型 · Agent 默认</option>${models.map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}`;
  const workflowOptions = [
    `<option value="">Workflow · 自动发现</option>`,
    ...workflows.map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)} · ${escapeHtml(workflow.id)}</option>`),
  ].join("");
  const agentIconSource = Object.entries(BUILTIN_AGENT_ICONS)
    .map(([id, markup]) => `${id}: ${toJavaScriptString(markup)}`)
    .join(",");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeBridge Workbench</title>
  <link rel="icon" href="data:," />
  <style>
    :root { color-scheme: light; --ink:#1e2523; --muted:#6d7773; --line:#dce2de; --paper:#f5f6f2; --panel:#ffffff; --accent:#23635b; --accent-soft:#e5f0ed; --warning:#9a6c27; --shadow:0 24px 60px -42px rgba(30,37,35,.62); }
    * { box-sizing:border-box; }
    [hidden] { display:none !important; }
    body { margin:0; min-height:100dvh; background:radial-gradient(circle at 75% 0%, #ffffff 0, transparent 38%), var(--paper); color:var(--ink); font:14px/1.55 "Avenir Next", "PingFang SC", ui-sans-serif, sans-serif; }
    button, input, select, textarea { font:inherit; }
    button { cursor:pointer; border:0; }
    .shell { min-height:100dvh; display:grid; grid-template-columns:300px 1fr; }
    .sidebar { position:sticky; top:0; height:100dvh; min-height:0; overflow:hidden; border-right:1px solid var(--line); background:#f1f3ef; padding:28px 18px; display:flex; flex-direction:column; gap:24px; }
    .brand { display:flex; align-items:center; justify-content:space-between; padding:0 8px; }
    .brand strong { letter-spacing:.08em; font-size:12px; text-transform:uppercase; }
    .brand span { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .inbox-head { display:flex; justify-content:space-between; align-items:center; padding:0 8px; }
    .inbox-head h2 { margin:0; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    .inbox-actions { display:flex; align-items:center; gap:6px; }
    .sync-button { background:transparent; color:var(--muted); border-radius:7px; padding:7px 8px; }
    .sync-button:hover { background:#e4e9e5; color:var(--accent); }
    .work-list { display:grid; gap:12px; overflow:auto; }
    #work-list { flex:1 1 auto; min-height:0; align-content:start; }
    #flow-list { flex:0 0 auto; max-height:28dvh; }
    .agent-group { display:grid; gap:3px; }
    .agent-group-head { display:flex; align-items:center; gap:4px; padding:3px 4px; color:var(--ink); }
    .agent-toggle { min-width:0; flex:1; display:flex; align-items:center; gap:7px; padding:7px 6px; border-radius:8px; background:transparent; color:var(--ink); text-align:left; }
    .agent-toggle:hover { background:#e4e9e5; }
    .agent-toggle strong { font-size:14px; font-weight:700; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .agent-icon { flex:0 0 18px; width:18px; height:18px; display:grid; place-items:center; color:var(--ink); }
    .agent-icon svg { display:block; width:18px; height:18px; }
    .agent-icon-fallback { border:1px solid var(--line); border-radius:5px; font:700 10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .agent-status, .agent-count { color:var(--muted); font:10px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .agent-count { margin-left:auto; }
    .agent-chevron { flex:0 0 14px; color:var(--muted); transition:transform .16s ease; }
    .agent-chevron.expanded { transform:rotate(90deg); }
    .agent-new { background:transparent; color:var(--accent); font-size:16px; padding:0 4px; }
    .agent-sessions { display:grid; gap:2px; margin-left:14px; padding-left:10px; border-left:1px solid var(--line); }
    .session-row-wrap { position:relative; display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center; }
    .work-row { min-width:0; display:grid; gap:3px; text-align:left; padding:8px 9px; border-radius:8px; background:transparent; color:var(--ink); }
    .work-row:hover, .work-row.active { background:#e4e9e5; }
    .work-row strong { font-size:12px; font-weight:500; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .work-row small { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .session-row-menu { opacity:0; transition:opacity .16s ease; }
    .session-row-wrap:hover .session-row-menu, .session-row-menu[open] { opacity:1; }
    .session-row-menu summary { list-style:none; display:grid; place-items:center; width:24px; height:24px; border-radius:6px; background:transparent; color:var(--muted); cursor:pointer; font-size:15px; }
    .session-row-menu summary::-webkit-details-marker { display:none; }
    .session-row-menu summary:hover, .session-row-menu[open] summary { background:#e4e9e5; color:var(--ink); }
    .session-row-menu-panel { position:absolute; z-index:3; top:30px; right:0; width:154px; display:grid; gap:2px; padding:6px; border:1px solid var(--line); border-radius:10px; background:#fff; box-shadow:var(--shadow); }
    .session-row-action { width:100%; border-radius:7px; background:transparent; color:var(--ink); padding:8px 9px; text-align:left; font-size:12px; }
    .session-row-action:hover { background:#edf1ee; }
    .session-row-action.danger { color:#a14835; }
    .empty { color:var(--muted); padding:18px 10px; border-top:1px solid var(--line); border-bottom:1px solid var(--line); }
    .main { min-width:0; padding:38px clamp(20px,5vw,72px); }
    .workspace { max-width:1040px; margin:0 auto; display:grid; gap:24px; }
    .workspace-top { display:flex; justify-content:space-between; gap:24px; align-items:flex-start; border-bottom:1px solid var(--line); padding-bottom:24px; }
    .eyebrow { color:var(--accent); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; text-transform:uppercase; letter-spacing:.12em; }
    h1 { margin:7px 0 5px; font-size:clamp(24px,3vw,38px); letter-spacing:-.035em; line-height:1.1; }
    .subline { margin:0; color:var(--muted); max-width:60ch; }
    .status { display:inline-flex; align-items:center; gap:7px; white-space:nowrap; color:var(--muted); font:12px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .status::before { content:""; width:7px; height:7px; border-radius:50%; background:var(--accent); box-shadow:0 0 0 4px var(--accent-soft); }
    .status.waiting::before { background:var(--warning); box-shadow:0 0 0 4px #f5ecd9; }
    .session-actions { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
    .session-action { border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--muted); padding:6px 9px; font-size:12px; }
    .session-action:hover { border-color:var(--accent); color:var(--accent); }
    .session-menu { position:relative; }
    .session-menu summary { list-style:none; display:grid; place-items:center; width:30px; height:30px; border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--muted); cursor:pointer; font-size:18px; line-height:1; }
    .session-menu summary::-webkit-details-marker { display:none; }
    .session-menu summary:hover, .session-menu[open] summary { border-color:var(--accent); color:var(--accent); }
    .session-menu-panel { position:absolute; z-index:2; top:36px; right:0; width:168px; display:grid; gap:2px; padding:6px; border:1px solid var(--line); border-radius:10px; background:#fff; box-shadow:var(--shadow); }
    .session-menu-action { width:100%; border-radius:7px; background:transparent; color:var(--ink); padding:8px 9px; text-align:left; font-size:12px; }
    .session-menu-action:hover { background:#edf1ee; }
    .session-menu-action.danger { color:#a14835; }
    .directory-panel { display:grid; gap:10px; border:1px solid var(--line); border-radius:12px; background:#fff; padding:14px; }
    .directory-head { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .directory-head strong { font-size:13px; }
    .directory-list { display:grid; gap:6px; }
    .directory-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 9px; border-radius:7px; background:#f5f7f5; color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-all; }
    .directory-remove { flex:0 0 auto; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--muted); padding:3px 6px; font-size:11px; }
    .directory-remove:hover { border-color:#a14835; color:#a14835; }
    .directory-add { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; }
    .attachment-list { display:flex; flex-wrap:wrap; gap:5px; }
    .attachment-chip { display:inline-flex; align-items:center; max-width:100%; border-radius:7px; background:var(--accent-soft); color:var(--accent); padding:4px 7px; font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .grid { display:grid; grid-template-columns:minmax(0,1fr); gap:24px; align-items:start; }
    .grid.inspector-visible { grid-template-columns:minmax(0,1fr) 300px; }
    .conversation-column { display:grid; gap:18px; min-width:0; }
    .conversation-column.empty-session { min-height:clamp(420px, calc(100dvh - 220px), 720px); align-content:center; }
    .conversation-column.empty-session .timeline { display:none; }
    .conversation-column.empty-session #workbench-error:empty { display:none; }
    .inspector { display:grid; gap:12px; position:sticky; top:24px; }
    .inspector-card { display:grid; gap:8px; border:1px solid var(--line); border-radius:12px; background:#fff; padding:13px; }
    .inspector-card h2 { margin:0; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    .inspector-value { color:var(--ink); font:12px ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-word; }
    .inspector-list { display:grid; gap:6px; }
    .inspector-row { display:grid; gap:2px; border-top:1px solid var(--line); padding-top:7px; }
    .inspector-row:first-child { border-top:0; padding-top:0; }
    .inspector-row strong { font-size:12px; }
    .inspector-row small { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-word; }
    .inspector-link { color:var(--accent); background:transparent; text-align:left; padding:0; font-size:12px; }
    .inspector-link:hover { text-decoration:underline; }
    .artifact-content { max-height:220px; overflow:auto; white-space:pre-wrap; word-break:break-word; background:#f5f7f5; border-radius:7px; padding:8px; color:var(--muted); font:11px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .timeline { min-height:330px; border-top:1px solid var(--line); }
    .timeline-empty { padding:42px 0; color:var(--muted); }
    .event { display:grid; grid-template-columns:116px 1fr; gap:18px; padding:14px 0; border-bottom:1px solid var(--line); }
    .event time { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .event-body strong { display:block; font-size:12px; letter-spacing:.04em; }
    .event-body pre { margin:5px 0 0; white-space:pre-wrap; word-break:break-word; color:var(--muted); font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .chat-composer { background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:16px; padding:12px; box-shadow:var(--shadow); }
    .form-grid { display:grid; gap:10px; }
    input, select, textarea { width:100%; border:1px solid var(--line); background:#fbfcfa; border-radius:7px; padding:9px 10px; color:var(--ink); outline:none; transition:border .2s ease, box-shadow .2s ease; }
    input:focus, select:focus, textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
    .input-shell { display:grid; grid-template-columns:auto 1fr auto; gap:8px; align-items:end; border:1px solid var(--line); border-radius:12px; background:#fbfcfa; padding:10px; }
    .message-input { min-height:100px; border:0; padding:3px 2px; background:transparent; box-shadow:none !important; resize:vertical; font-size:16px; line-height:1.6; }
    .message-input:focus { border:0; }
    .composer-tools, .input-actions { display:flex; align-items:center; gap:4px; }
    .tool-button { width:30px; height:30px; border-radius:8px; background:#edf1ee; color:var(--ink); font-size:17px; }
    .tool-button:hover { background:var(--accent-soft); color:var(--accent); }
    .send-button { width:34px; height:34px; border-radius:10px; background:var(--ink); color:#fff; font-size:19px; line-height:1; }
    .send-button:hover { background:var(--accent); }
    .composer-context { display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:3px 3px 8px; }
    .context-control, .context-chip { width:auto; min-height:28px; border:1px solid var(--line); border-radius:8px; background:#f7f9f7; color:var(--muted); padding:5px 8px; font-size:12px; }
    .context-control { outline:none; }
    .context-control:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
    .context-chip { display:inline-flex; align-items:center; flex:0 0 auto; }
    .directory-note { color:var(--muted); font-size:12px; }
    .actions { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
    .flow-row-wrap { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px; align-items:center; }
    .flow-review { border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--accent); padding:5px 7px; font-size:11px; }
    .primary { background:var(--accent); color:#fff; border-radius:8px; padding:10px 13px; transition:transform .2s ease, filter .2s ease; }
    .primary:hover { filter:brightness(1.08); transform:translateY(-1px); }
    .secondary { background:#edf1ee; color:var(--ink); border-radius:8px; padding:10px 13px; }
    .error { color:#a14835; font-size:12px; min-height:18px; }
    .meta { display:grid; gap:8px; border-top:1px solid var(--line); margin-top:18px; padding-top:16px; color:var(--muted); font-size:12px; }
    .meta div { display:flex; justify-content:space-between; gap:12px; }
    .meta code { color:var(--ink); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width:800px) { .shell { grid-template-columns:1fr; } .sidebar { position:static; height:auto; overflow:visible; border-right:0; border-bottom:1px solid var(--line); padding:18px; } .work-list, #flow-list { max-height:190px; } .main { padding:26px 18px 44px; } .workspace-top { flex-direction:column; } .composer-context { gap:5px; } .context-control, .context-chip { flex:1 1 auto; } .grid, .grid.inspector-visible { grid-template-columns:1fr; } .inspector { position:static; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><strong>CodeBridge</strong><span>WORKBENCH / 01</span></div>
      <div class="inbox-head"><h2>Agents</h2><div class="inbox-actions"><button class="sync-button" id="session-view-toggle" title="显示已归档 Session" type="button">已归档</button><button class="sync-button" id="sync-sessions" title="从 Agent 导入已有会话" type="button">导入历史</button></div></div>
      <div class="work-list" id="work-list"><div class="empty">正在读取 Agent 会话…</div></div>
      <div class="inbox-head"><h2>Flows</h2></div>
      <div class="work-list" id="flow-list"><div class="empty">Flow 会在当前会话中自动发现或由你选择。</div></div>
    </aside>
    <main class="main">
      <div class="workspace">
        <header class="workspace-top">
          <div><div class="eyebrow">CodeBridge Workbench</div><h1 id="title">选择一个 Agent 开始</h1><p class="subline" id="subtitle" hidden></p></div>
          <div class="session-actions" id="session-actions" hidden><button class="session-action" id="session-resume" type="button">继续</button><button class="session-action" id="session-inspector-toggle" hidden type="button" aria-expanded="false">运行详情</button><details class="session-menu" id="session-menu" hidden><summary aria-label="运行操作" title="运行操作">···</summary><div class="session-menu-panel"><button class="session-menu-action" id="session-fork" hidden type="button">创建分支</button><button class="session-menu-action" id="run-again" hidden type="button">再次运行</button></div></details><span class="status" id="status" hidden>idle</span></div>
        </header>
        <div class="grid" id="session-grid">
           <section class="conversation-column" id="conversation-column">
            <section class="directory-panel" id="directory-panel" hidden>
              <div class="directory-head"><strong>Session 目录</strong><span class="directory-note">下次运行时生效</span></div>
              <div class="directory-list" id="directory-list"><div class="empty">当前没有附加目录。</div></div>
              <div class="directory-add"><input id="additional-directory" aria-label="附加目录" placeholder="输入要加入当前 Session 的目录路径" autocomplete="off" /><button class="secondary" id="add-directory" type="button">添加</button></div>
              <div class="error" id="directory-error"></div>
            </section>
            <div class="timeline" id="timeline"><div class="timeline-empty">选择左侧 Agent 创建 Session</div></div><div class="error" id="workbench-error"></div>
            <form class="chat-composer form-grid" id="reply-form" hidden>
              <div class="composer-context">
                <select class="context-control" id="reply-workflow" aria-label="Workflow"${workflows.length ? "" : " hidden"}>${workflowOptions}</select><button class="context-chip" id="session-directories" type="button"><span id="reply-workspace-chip">工作空间 · 自动发现</span></button><select class="context-control" id="reply-model" aria-label="模型"${models.length ? "" : " hidden"}>${modelOptions}</select>
              </div>
               <div class="input-shell">
                 <div class="composer-tools"><button class="tool-button" id="reply-attach-button" type="button" aria-label="添加文件">＋</button></div>
                 <textarea class="message-input" id="reply" placeholder="输入任务…"></textarea>
                 <div class="input-actions"><button class="tool-button" id="reply-mention-button" type="button" aria-label="引用上下文">@</button><button class="tool-button" id="reply-command-button" type="button" aria-label="插入命令">/</button><button class="send-button" type="submit" aria-label="发送">↑</button></div>
               </div>
               <input id="reply-attachment-picker" type="file" multiple hidden />
               <div class="attachment-list" id="reply-attachment-list"></div>
              <div class="error" id="reply-error"></div>
              <div class="actions"><button class="secondary" id="save-flow" type="button" hidden>保存为 Workflow Candidate</button><button class="secondary" id="accept-project" type="button" hidden>确认登记发现的资源</button><button class="secondary" id="approve-run" type="button" hidden>批准本次操作</button><button class="secondary" id="reject-run" type="button" hidden>拒绝本次操作</button></div>
            </form>
           </section>
           <aside class="inspector" id="run-inspector" hidden>
             <section class="inspector-card"><h2>Run</h2><div class="inspector-value" id="run-state">等待 Session</div><div class="inspector-value" id="run-id"></div></section>
             <section class="inspector-card" id="approval-card" hidden><h2>Approval</h2><div class="inspector-list" id="approval-list"><div class="empty">当前 Run 没有审批记录。</div></div></section>
             <section class="inspector-card" id="artifact-card" hidden><h2>Artifacts</h2><div class="inspector-list" id="artifact-list"><div class="empty">当前 Run 没有产物。</div></div><pre class="artifact-content" id="artifact-content" hidden></pre></section>
             <section class="inspector-card" id="verification-card" hidden><h2>Verification</h2><div class="inspector-list" id="verification-list"><div class="empty">当前 Run 没有验证结果。</div></div></section>
             <section class="inspector-card" id="catalog-drift-card" hidden><h2>Catalog drift</h2><div class="inspector-list" id="project-drift-list"><div class="empty">没有待审核的目录变化。</div></div></section>
           </aside>
         </div>
      </div>
    </main>
  </div>
  <script>
    const TOKEN = __TOKEN__;
    const agentIcons = {${agentIconSource}};
    const state = { selected: null, sequence: 0, timer: null, eventAbort: null, session: null, latestRunId: null, ephemeralFlow: null, projectCandidateId: null, approval: null, showArchived: false, collapsedAgents: new Set(${JSON.stringify(agentProfiles.map((agent) => agent.id))}) };
    const $ = (id) => document.getElementById(id);
    const api = async (url, init = {}) => {
      const response = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(init.headers || {}) } });
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
      return response.status === 204 ? null : response.json();
    };
    const agentModels = ${JSON.stringify({ "": models, ...Object.fromEntries(agentProfiles.map((agent) => [agent.id, agent.models ?? []])) })};
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const label = (value) => ({ WORK_ITEM_CREATED:'创建', MESSAGE_RECEIVED:'消息', RUN_CREATED:'运行排队', RUN_STARTED:'运行开始', STEP_STARTED:'步骤开始', STEP_SKIPPED:'步骤跳过', AGENT_EVENT:'Agent 事件', FLOW_PROPOSED:'流程建议', FLOW_SAVED_AS_CANDIDATE:'流程已保存', STEP_SUCCEEDED:'步骤完成', RUN_SUCCEEDED:'运行成功', RUN_FAILED:'运行失败', PROJECT_CANDIDATE_FOUND:'发现资源', APPROVAL_REQUESTED:'需要确认', APPROVAL_GRANTED:'已确认', APPROVAL_REJECTED:'已拒绝', BRANCH_SELECTED:'分支选择', WORK_ITEM_COMPLETED:'工作完成' }[value] || value);
    const modeLabel = (value) => ({ auto:'Agent 判断中', investigation:'调查', change:'修改', review:'Review', release:'发布', observe:'观察' }[value] || value || '待判断');
    const insertToken = (id, token) => { const input = $(id); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; input.value = input.value.slice(0, start) + token + input.value.slice(end); input.focus(); input.selectionStart = input.selectionEnd = start + token.length; };
    function renderPendingAttachments(inputId, listId) { const files = [...($(inputId).files || [])]; $(listId).innerHTML = files.map((file) => '<span class="attachment-chip">' + esc(file.name) + ' · ' + esc(file.type || 'file') + '</span>').join(''); }
    async function encodePendingAttachments(inputId) {
      const files = [...($(inputId).files || [])];
      return Promise.all(files.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('读取附件失败：' + file.name));
        reader.onload = () => { const dataUrl = String(reader.result || ''); resolve({ name: file.name, mime_type: file.type || 'application/octet-stream', data_base64: dataUrl.slice(dataUrl.indexOf(',') + 1) }); };
        reader.readAsDataURL(file);
      })));
    }
    function applyFlows(flows) { const options = '<option value="">Workflow · 自动发现</option>' + flows.map((flow) => '<option value="' + esc(flow.flow_id) + '">' + esc(flow.name || flow.flow_id) + ' · ' + esc(flow.flow_id) + '</option>').join(''); $('reply-workflow').innerHTML = options; $('reply-workflow').hidden = flows.length === 0; }
    async function loadFlows() { try { const result = await api('/v1/flows'); const flows = result.flows || []; applyFlows(flows); $('flow-list').innerHTML = flows.length ? flows.map((flow) => '<div class="flow-row-wrap"><button class="work-row flow-row" data-flow="' + esc(flow.flow_id) + '"><strong>' + esc(flow.name || flow.flow_id) + '</strong><small>' + esc(flow.status) + ' · ' + esc(flow.kind) + '</small></button>' + (flow.status === 'candidate' ? '<button class="flow-review" data-review-flow="' + esc(flow.flow_id) + '" type="button">审核</button>' : '') + '</div>').join('') : '<div class="empty">暂无 Flow</div>'; document.querySelectorAll('.flow-row').forEach((button) => button.addEventListener('click', () => { $('reply-workflow').value = button.dataset.flow; })); document.querySelectorAll('.flow-review').forEach((button) => button.addEventListener('click', () => reviewFlow(button.dataset.reviewFlow).catch((error) => { $('reply-error').textContent = error.message; }))); } catch (error) { $('flow-list').innerHTML = '<div class="empty">无法读取 Flow：' + esc(error.message) + '</div>'; } }
    async function reviewFlow(flowId) { const decision = window.confirm('发布这个 Workflow Candidate？\\n取消将保留 Candidate 不变。') ? 'approve' : 'reject'; const gitRevision = decision === 'approve' ? window.prompt('输入已审核的 Git revision') : null; if (decision === 'approve' && !gitRevision) return; await api('/v1/flows/' + encodeURIComponent(flowId) + '/review', { method:'POST', body: JSON.stringify({ decision, ...(gitRevision ? { git_revision: gitRevision } : {}) }) }); await loadFlows(); }
    async function syncSessions() {
      const button = $('sync-sessions');
      button.disabled = true;
      const label = button.textContent;
      button.textContent = '同步中…';
      try {
        await api('/v1/sessions?import=true');
        await loadSessions();
      } catch (error) {
        $('work-list').innerHTML = '<div class="empty">同步失败：' + esc(error.message) + '</div>';
      } finally {
        button.disabled = false;
        button.textContent = label;
      }
    }
    async function loadSessions() {
      try {
        const result = await api('/v1/sessions' + (state.showArchived ? '?include_archived=true' : ''));
        const sessions = (result.sessions || []).filter((session) => state.showArchived ? Boolean(session.archived_at) : !session.archived_at);
        const groups = sessions.reduce((map, session) => { (map[session.agent_id] ||= []).push(session); return map; }, {});
        const agentIds = [...new Set([${JSON.stringify(agentProfiles.map((agent) => agent.id))}, ...Object.keys(groups)].flat())];
        const agentLabels = ${JSON.stringify(Object.fromEntries(agentProfiles.map((agent) => [agent.id, agent.name])))};
        const agentStatuses = ${JSON.stringify(Object.fromEntries(agentProfiles.map((agent) => [agent.id, agent.status ?? ""]))) };
        $('work-list').innerHTML = agentIds.map((agentId, index) => {
          const canCreate = !agentStatuses[agentId] || agentStatuses[agentId] === 'healthy';
          const sessionsForAgent = groups[agentId] || [];
          const collapsed = state.collapsedAgents.has(agentId);
          const sessionsId = 'agent-sessions-' + index;
          const newButton = canCreate ? '<button class="agent-new" data-agent="' + esc(agentId) + '" aria-label="新建 ' + esc(agentLabels[agentId] || agentId) + ' Session" type="button">＋</button>' : '';
          const sessionRows = sessionsForAgent.map((session) => {
            const title = session.title || '新会话';
            const pinAction = session.archived_at ? '' : '<button class="session-row-action" data-session-action="pin" data-session-id="' + esc(session.session_id) + '" data-session-pinned="' + String(Boolean(session.pinned_at)) + '" type="button">' + (session.pinned_at ? '取消置顶' : '置顶') + '</button>';
            const archiveLabel = session.archived_at ? '取消归档' : '归档';
            return '<div class="session-row-wrap"><button class="work-row ' + (state.selected === session.session_id ? 'active' : '') + '" data-id="' + esc(session.session_id) + '" type="button"><strong>' + esc(title) + '</strong></button><details class="session-row-menu"><summary aria-label="操作 ' + esc(title) + '" title="Session 操作">···</summary><div class="session-row-menu-panel">' + pinAction + '<button class="session-row-action" data-session-action="rename" data-session-id="' + esc(session.session_id) + '" data-session-title="' + esc(title) + '" type="button">重命名</button><button class="session-row-action" data-session-action="archive" data-session-id="' + esc(session.session_id) + '" data-session-archived="' + String(Boolean(session.archived_at)) + '" type="button">' + archiveLabel + '</button><button class="session-row-action danger" data-session-action="delete" data-session-id="' + esc(session.session_id) + '" type="button">删除</button></div></details></div>';
          }).join('');
          const status = agentStatuses[agentId] ? '<span class="agent-status">' + esc(agentStatuses[agentId]) + '</span>' : '';
          const icon = agentIcons[agentId] || '<span class="agent-icon-fallback" data-agent-icon="' + esc(agentId) + '">' + esc((agentLabels[agentId] || agentId).slice(0, 1).toUpperCase()) + '</span>';
          return '<section class="agent-group"><div class="agent-group-head"><button class="agent-toggle" data-agent-toggle="' + esc(agentId) + '" aria-expanded="' + String(!collapsed) + '" aria-controls="' + sessionsId + '" type="button"><span class="agent-chevron ' + (collapsed ? '' : 'expanded') + '">›</span><span class="agent-icon" aria-hidden="true">' + icon + '</span><strong>' + esc(agentLabels[agentId] || agentId) + '</strong>' + status + '<span class="agent-count">' + sessionsForAgent.length + '</span></button>' + newButton + '</div><div class="agent-sessions" id="' + sessionsId + '"' + (collapsed ? ' hidden' : '') + '>' + (sessionRows || '<div class="empty">还没有会话</div>') + '</div></section>';
        }).join('');
        document.querySelectorAll('#work-list .work-row').forEach((button) => {
          button.addEventListener('click', () => selectSession(button.dataset.id));
          button.addEventListener('contextmenu', (event) => { event.preventDefault(); const menu = button.closest('.session-row-wrap')?.querySelector('.session-row-menu'); if (menu) menu.open = true; });
        });
        document.querySelectorAll('[data-session-action]').forEach((button) => button.addEventListener('click', () => { void handleSessionAction(button).catch((error) => { $('workbench-error').textContent = error.message; }); }));
        document.querySelectorAll('.agent-toggle').forEach((button) => button.addEventListener('click', () => {
          const agentId = button.dataset.agentToggle;
          if (!agentId) return;
          const sessions = $(button.getAttribute('aria-controls'));
          const expanded = state.collapsedAgents.has(agentId);
          if (expanded) state.collapsedAgents.delete(agentId); else state.collapsedAgents.add(agentId);
          button.setAttribute('aria-expanded', String(expanded));
          if (sessions) sessions.hidden = !expanded;
          button.querySelector('.agent-chevron')?.classList.toggle('expanded', expanded);
        }));
        document.querySelectorAll('.agent-new').forEach((button) => button.addEventListener('click', () => { void newSession(button.dataset.agent).catch((error) => { $('workbench-error').textContent = error.message; }); }));
      } catch (error) { $('work-list').innerHTML = '<div class="empty">无法读取：' + esc(error.message) + '</div>'; }
    }
    async function handleSessionAction(button) {
      const sessionId = button.dataset.sessionId;
      const action = button.dataset.sessionAction;
      if (!sessionId || !action) return;
      if (action === 'delete') {
        if (!window.confirm('删除这个 Session？此操作会同时删除对应 Agent 的会话历史。')) return;
        const deletingSelected = state.selected === sessionId;
        if (deletingSelected) { clearInterval(state.timer); state.eventAbort?.abort(); }
        try {
          await api('/v1/sessions/' + encodeURIComponent(sessionId), { method:'DELETE' });
          if (deletingSelected) resetWorkbench(); else await loadSessions();
        } catch (error) {
          if (deletingSelected) { state.timer = setInterval(() => { void refreshSession(); }, 1200); void startEventStream(); }
          throw error;
        }
        return;
      }
      let update;
      if (action === 'rename') {
        const title = window.prompt('重命名 Session', button.dataset.sessionTitle || '');
        if (!title?.trim()) return;
        update = { title: title.trim() };
      } else if (action === 'pin') {
        update = { pinned: button.dataset.sessionPinned !== 'true' };
      } else if (action === 'archive') {
        update = { archived: button.dataset.sessionArchived !== 'true' };
      } else return;
      await api('/v1/sessions/' + encodeURIComponent(sessionId), { method:'PATCH', body: JSON.stringify(update) });
      if (action === 'archive' && state.selected === sessionId) resetWorkbench();
      else { if (state.selected === sessionId) await refreshSession(); await loadSessions(); }
    }
    async function newSession(agentId) {
      if (!agentId) return;
      $('workbench-error').textContent = '';
      const session = await api('/v1/sessions', { method:'POST', body: JSON.stringify({ agent_id: agentId }) });
      await selectSession(session.session_id);
    }
    function resetWorkbench() {
      state.eventAbort?.abort(); state.selected = null; state.session = null; state.latestRunId = null; state.sequence = 0; state.ephemeralFlow = null; state.projectCandidateId = null; state.approval = null; clearInterval(state.timer);
      $('title').textContent = '选择一个 Agent 开始'; $('subtitle').textContent = ''; $('subtitle').hidden = true; $('session-actions').hidden = true; $('session-menu').open = false; $('session-menu').hidden = true; $('session-fork').hidden = true; $('session-inspector-toggle').hidden = true; $('session-inspector-toggle').setAttribute('aria-expanded', 'false'); $('run-inspector').hidden = true; $('session-grid').classList.remove('inspector-visible'); $('conversation-column').classList.remove('empty-session'); $('approval-card').hidden = true; $('artifact-card').hidden = true; $('verification-card').hidden = true; $('catalog-drift-card').hidden = true; $('run-again').hidden = true; $('run-state').textContent = '等待 Session'; $('run-id').textContent = ''; $('artifact-content').hidden = true; $('project-drift-list').innerHTML = '<div class="empty">没有待审核的目录变化。</div>'; $('directory-panel').hidden = true; $('directory-list').innerHTML = '<div class="empty">当前没有附加目录。</div>'; $('directory-error').textContent = ''; $('additional-directory').value = ''; $('reply-attachment-picker').value = ''; renderPendingAttachments('reply-attachment-picker', 'reply-attachment-list'); $('timeline').innerHTML = '<div class="timeline-empty">选择左侧 Agent 创建 Session</div>'; $('reply-form').hidden = true; $('reply-model').value = ''; $('workbench-error').textContent = ''; $('save-flow').hidden = true; $('accept-project').hidden = true; $('approve-run').hidden = true; $('reject-run').hidden = true; loadSessions();
    }
    async function selectSession(id) {
      state.eventAbort?.abort(); state.selected = id; state.sequence = 0; state.session = null; state.latestRunId = null; state.ephemeralFlow = null; state.projectCandidateId = null; state.approval = null; $('save-flow').hidden = true; $('accept-project').hidden = true; $('approve-run').hidden = true; $('reject-run').hidden = true; $('session-menu').open = false; $('session-menu').hidden = true; $('session-inspector-toggle').hidden = true; $('session-inspector-toggle').setAttribute('aria-expanded', 'false'); $('run-inspector').hidden = true; $('session-grid').classList.remove('inspector-visible'); $('conversation-column').classList.add('empty-session'); $('approval-card').hidden = true; $('artifact-card').hidden = true; $('verification-card').hidden = true; $('catalog-drift-card').hidden = true; $('session-fork').hidden = true; $('run-again').hidden = true; $('artifact-content').hidden = true; $('directory-panel').hidden = true; $('directory-error').textContent = ''; $('timeline').innerHTML = '<div class="timeline-empty">暂无消息</div>'; $('reply-form').hidden = false; $('session-actions').hidden = false; $('workbench-error').textContent = '';
      await refreshSession(true); void startEventStream(); loadSessions();
      void loadDrifts();
      clearInterval(state.timer); state.timer = setInterval(() => { void refreshSession(); }, 1200);
    }
    async function refreshSession(readEvents = false) {
      if (!state.selected) return;
      try {
        const session = await api('/v1/sessions/' + encodeURIComponent(state.selected));
        state.session = session;
        const agent = session.agent_id || '自动选择';
        const scope = session.cwd || '';
        $('title').textContent = session.title || 'Session'; $('subtitle').textContent = agent + ' · ' + (session.status || 'idle'); $('subtitle').hidden = false; $('status').textContent = session.status || 'idle'; $('status').className = 'status ' + (session.status === 'waiting' ? 'waiting' : '');
        $('session-resume').hidden = session.status !== 'closed';
        $('session-fork').hidden = !session.provider_session_id;
        $('session-menu').hidden = !session.provider_session_id && state.latestRunId === null;
        $('reply-workflow').value = session.flow_id || ''; applyModels(agent); $('reply-model').value = session.model || '';
         $('reply-workspace-chip').textContent = scope ? '工作空间 · ' + scope : '工作空间 · Agent 自动发现';
         renderDirectories(session);
         await refreshInspector();
        if (readEvents) {
          const response = await fetch('/v1/sessions/' + encodeURIComponent(state.selected) + '/events?after_sequence=' + state.sequence, { headers: { authorization: 'Bearer ' + TOKEN } });
          const text = await response.text();
          const events = [...text.matchAll(/data: (\{.*\})/g)].map((match) => JSON.parse(match[1]));
          if (events.length) { state.sequence = events[events.length - 1].sequence; renderEvents(events); }
        }
      } catch (error) { $('workbench-error').textContent = error.message; $('reply-error').textContent = error.message; }
    }
    function renderDirectories(session) {
      const directories = session.additional_directories || [];
      $('directory-list').innerHTML = directories.length
        ? directories.map((directory) => '<div class="directory-row"><span>' + esc(directory) + '</span><button class="directory-remove" type="button" data-directory="' + esc(directory) + '">移除</button></div>').join('')
        : '<div class="empty">当前没有附加目录。</div>';
      document.querySelectorAll('.directory-remove').forEach((button) => button.addEventListener('click', () => {
        removeDirectory(button.dataset.directory || '').catch((error) => { $('directory-error').textContent = error.message; });
      }));
    }
    async function addDirectory() {
      if (!state.selected) return;
      const input = $('additional-directory');
      const directory = input.value.trim();
      $('directory-error').textContent = '';
      if (!directory) { input.focus(); return; }
      const button = $('add-directory');
      button.disabled = true;
      try {
        await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/directories', { method:'POST', body: JSON.stringify({ path: directory }) });
        input.value = '';
        await refreshSession();
      } catch (error) { $('directory-error').textContent = error.message; }
      finally { button.disabled = false; }
    }
    async function removeDirectory(directory) {
      if (!state.selected || !directory) return;
      $('directory-error').textContent = '';
      await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/directories', { method:'DELETE', body: JSON.stringify({ path: directory }) });
      await refreshSession();
    }
    async function refreshInspector(force = false) {
      if (!state.selected) return;
      const result = await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/runs');
      const runs = result.runs || [];
      const run = runs[runs.length - 1];
      if (!run) {
        state.latestRunId = null;
        $('run-inspector').hidden = true;
        $('session-grid').classList.remove('inspector-visible');
        $('session-inspector-toggle').hidden = true;
        $('session-inspector-toggle').setAttribute('aria-expanded', 'false');
        $('session-menu').hidden = !state.session?.provider_session_id;
        $('run-again').hidden = true;
        $('approval-card').hidden = true;
        $('artifact-card').hidden = true;
        $('verification-card').hidden = true;
        $('run-state').textContent = '尚未运行';
        $('run-id').textContent = '';
        $('approval-list').innerHTML = '<div class="empty">当前 Run 没有审批记录。</div>';
        $('artifact-list').innerHTML = '<div class="empty">当前 Run 没有产物。</div>';
        $('verification-list').innerHTML = '<div class="empty">当前 Run 没有验证结果。</div>';
        $('artifact-content').hidden = true;
        return;
      }
      $('session-inspector-toggle').hidden = false;
      $('session-menu').hidden = false;
      $('run-again').hidden = false;
      $('run-state').textContent = run.status || 'unknown';
      $('run-id').textContent = run.run_id;
      const changed = state.latestRunId !== run.run_id;
      state.latestRunId = run.run_id;
      if (!changed && !force) return;
      const [approvalResult, artifactResult, verificationResult] = await Promise.all([
        api('/v1/runs/' + encodeURIComponent(run.run_id) + '/approvals'),
        api('/v1/runs/' + encodeURIComponent(run.run_id) + '/artifacts'),
        api('/v1/runs/' + encodeURIComponent(run.run_id) + '/verifications'),
      ]);
      const approvals = approvalResult.approvals || [];
      $('approval-card').hidden = approvals.length === 0;
      $('approval-list').innerHTML = approvals.length ? approvals.map((approval) => '<div class="inspector-row"><strong>' + esc(approval.capability_id) + ' · ' + esc(approval.status) + '</strong><small>' + esc(approval.environment) + ' · ' + esc(approval.target_resource) + '</small><small>' + esc(approval.input_hash) + '</small></div>').join('') : '<div class="empty">当前 Run 没有审批记录。</div>';
      const pending = [...approvals].reverse().find((approval) => approval.status === 'requested');
      if (pending) { state.approval = { approvalId: pending.id, runId: run.run_id }; $('approve-run').hidden = false; $('reject-run').hidden = false; }
      else if (state.approval?.runId === run.run_id) { state.approval = null; $('approve-run').hidden = true; $('reject-run').hidden = true; }
      const artifacts = artifactResult.artifacts || [];
      $('artifact-card').hidden = artifacts.length === 0;
      $('artifact-list').innerHTML = artifacts.length ? artifacts.map((artifact) => '<div class="inspector-row"><button class="inspector-link" type="button" data-artifact="' + esc(artifact.id) + '">' + esc(artifact.name) + '</button><small>' + esc(artifact.kind) + ' · ' + esc(artifact.mime_type) + '</small><small>' + esc(artifact.content_hash) + '</small></div>').join('') : '<div class="empty">当前 Run 没有产物。</div>';
      document.querySelectorAll('.inspector-link[data-artifact]').forEach((button) => button.addEventListener('click', () => showArtifact(button.dataset.artifact || '').catch((error) => { $('reply-error').textContent = error.message; })));
      const verifications = verificationResult.verifications || [];
      $('verification-card').hidden = verifications.length === 0;
      $('verification-list').innerHTML = verifications.length ? verifications.map((verification) => '<div class="inspector-row"><strong>' + esc(verification.validator) + ' · ' + esc(verification.status) + '</strong><small>' + esc(verification.summary) + '</small></div>').join('') : '<div class="empty">当前 Run 没有验证结果。</div>';
    }
    async function showArtifact(artifactId) {
      if (!artifactId) return;
      const artifact = await api('/v1/artifacts/' + encodeURIComponent(artifactId));
      $('artifact-content').textContent = artifact.content || '';
      $('artifact-content').hidden = false;
    }
    async function loadDrifts() {
      try {
        const result = await api('/v1/projects/drifts');
        const drifts = result.drifts || [];
        $('catalog-drift-card').hidden = drifts.length === 0;
        $('project-drift-list').innerHTML = drifts.length ? drifts.map((drift) => '<div class="inspector-row"><strong>' + esc(drift.project_id) + '</strong>' + (drift.changes || []).map((change) => '<small>' + esc(change.field) + ': ' + esc(JSON.stringify(change.registered)) + ' → ' + esc(JSON.stringify(change.observed)) + '</small>').join('') + '<div class="actions"><button class="inspector-link" type="button" data-drift-action="apply" data-drift-id="' + esc(drift.id) + '">应用</button><button class="inspector-link" type="button" data-drift-action="resolve" data-drift-id="' + esc(drift.id) + '">忽略</button></div></div>').join('') : '<div class="empty">没有待审核的目录变化。</div>';
        document.querySelectorAll('[data-drift-action]').forEach((button) => button.addEventListener('click', () => resolveDrift(button.dataset.driftId || '', button.dataset.driftAction || '').catch((error) => { $('reply-error').textContent = error.message; })));
      } catch (error) { $('catalog-drift-card').hidden = true; $('project-drift-list').innerHTML = '<div class="empty">无法读取目录变化：' + esc(error.message) + '</div>'; }
    }
    async function resolveDrift(driftId, action) {
      if (!driftId || !['apply', 'resolve'].includes(action)) return;
      await api('/v1/projects/drifts/' + encodeURIComponent(driftId) + '/' + action, { method:'POST', body: '{}' });
      await loadDrifts();
    }
    async function startEventStream() {
      if (!state.selected) return;
      const sessionId = state.selected;
      const controller = new AbortController();
      state.eventAbort = controller;
      try {
        const response = await fetch('/v1/sessions/' + encodeURIComponent(sessionId) + '/events?live=true&after_sequence=' + state.sequence, { headers: { authorization: 'Bearer ' + TOKEN }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error('事件流连接失败');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted && state.selected === sessionId) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream:true });
          const blocks = buffer.split('\\n\\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const data = block.split('\\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\\n');
            if (!data) continue;
            const event = JSON.parse(data);
            if (event.sequence <= state.sequence) continue;
            state.sequence = event.sequence;
            renderEvents([event]);
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && state.selected === sessionId) {
          $('reply-error').textContent = error.message;
          setTimeout(() => { if (state.selected === sessionId) void startEventStream(); }, 1000);
        }
      }
    }
    function renderEvents(events) {
      const target = $('timeline');
      if (target.querySelector('.timeline-empty')) target.innerHTML = '';
      if (events.length) $('conversation-column').classList.remove('empty-session');
      target.insertAdjacentHTML('beforeend', events.map((event) => '<article class="event"><time>' + esc(new Date(event.occurred_at).toLocaleTimeString()) + '</time><div class="event-body"><strong>' + esc(label(event.type)) + '</strong><pre>' + esc(JSON.stringify(event.payload || {}, null, 2)) + '</pre></div></article>').join(''));
      const proposal = [...events].reverse().find((event) => event.type === 'FLOW_PROPOSED' && event.payload && event.payload.flow && typeof event.payload.flow === 'object' && !Array.isArray(event.payload.flow));
      if (proposal) {
        state.ephemeralFlow = { flow: proposal.payload.flow, definition_revision: typeof proposal.payload.definition_revision === 'string' ? proposal.payload.definition_revision : 'event:' + proposal.event_id };
        $('save-flow').hidden = false;
      }
      const candidate = [...events].reverse().find((event) => event.type === 'PROJECT_CANDIDATE_FOUND' && typeof event.payload?.candidate_id === 'string');
      if (candidate) {
        state.projectCandidateId = candidate.payload.candidate_id;
        $('accept-project').hidden = false;
      }
      const approval = [...events].reverse().find((event) => event.type === 'APPROVAL_REQUESTED' && typeof event.payload?.approval_id === 'string' && event.run_id);
      if (approval) { state.approval = { approvalId: approval.payload.approval_id, runId: approval.run_id }; $('approve-run').hidden = false; $('reject-run').hidden = false; }
      const resolvedApproval = [...events].reverse().find((event) => event.type === 'APPROVAL_GRANTED' || event.type === 'APPROVAL_REJECTED');
      if (resolvedApproval) { state.approval = null; $('approve-run').hidden = true; $('reject-run').hidden = true; }
      if (events.some((event) => event.run_id)) void refreshInspector(true).catch((error) => { $('reply-error').textContent = error.message; });
      target.scrollTop = target.scrollHeight;
    }
    $('save-flow').addEventListener('click', async () => {
      if (!state.selected || !state.ephemeralFlow) return;
      const button = $('save-flow');
      button.disabled = true;
      $('reply-error').textContent = '';
      try {
        await api('/v1/flows/candidates', { method:'POST', body: JSON.stringify({ session_id: state.selected, definition_revision: state.ephemeralFlow.definition_revision, flow: state.ephemeralFlow.flow }) });
        state.ephemeralFlow = null;
        button.hidden = true;
        await loadFlows();
      } catch (error) { $('reply-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    async function resolveApproval(decision) { if (!state.approval) return; const endpoint = decision === 'approve' ? 'approve' : 'reject'; await api('/v1/runs/' + encodeURIComponent(state.approval.runId) + '/' + endpoint, { method:'POST', body: JSON.stringify({ approval_id: state.approval.approvalId }) }); state.approval = null; $('approve-run').hidden = true; $('reject-run').hidden = true; await refreshSession(); }
    $('approve-run').addEventListener('click', () => resolveApproval('approve').catch((error) => { $('reply-error').textContent = error.message; }));
    $('reject-run').addEventListener('click', () => resolveApproval('reject').catch((error) => { $('reply-error').textContent = error.message; }));
    $('accept-project').addEventListener('click', async () => {
      if (!state.projectCandidateId) return;
      const button = $('accept-project');
      button.disabled = true;
      $('reply-error').textContent = '';
      try {
        await api('/v1/projects/candidates/' + encodeURIComponent(state.projectCandidateId) + '/accept', { method:'POST', body: '{}' });
         state.projectCandidateId = null;
         button.hidden = true;
         await loadDrifts();
      } catch (error) { $('reply-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    $('session-resume').addEventListener('click', async () => {
      if (!state.selected) return;
      try { await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/resume', { method:'POST', body: '{}' }); await refreshSession(); loadSessions(); }
      catch (error) { $('reply-error').textContent = error.message; }
    });
    $('session-inspector-toggle').addEventListener('click', () => {
      const visible = $('run-inspector').hidden;
      $('run-inspector').hidden = !visible;
      $('session-grid').classList.toggle('inspector-visible', visible);
      $('session-inspector-toggle').setAttribute('aria-expanded', String(visible));
    });
    $('session-fork').addEventListener('click', async () => {
      if (!state.selected) return;
      try { const forked = await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/fork', { method:'POST', body: JSON.stringify({}) }); await selectSession(forked.session_id); }
      catch (error) { $('reply-error').textContent = error.message; }
    });
    $('session-directories').addEventListener('click', () => {
      $('directory-panel').hidden = !$('directory-panel').hidden;
      if (!$('directory-panel').hidden) $('additional-directory').focus();
    });
    $('add-directory').addEventListener('click', () => addDirectory());
    $('additional-directory').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void addDirectory(); } });
    function applyModels(agentId) { const models = agentModels[agentId] || []; const options = '<option value="">模型 · Agent 默认</option>' + models.map((model) => '<option value="' + esc(model) + '">' + esc(model) + '</option>').join(''); $('reply-model').innerHTML = options; $('reply-model').hidden = models.length === 0; }
    async function startRun() { if (!state.selected) return; await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/runs', { method:'POST', body: JSON.stringify({ flow_id: $('reply-workflow').value || null, model: $('reply-model').value || null, mode: 'auto' }) }); await refreshSession(); }
    $('reply-form').addEventListener('submit', async (event) => { event.preventDefault(); $('reply-error').textContent = ''; if (!state.selected || !$('reply').value.trim()) return; try { const attachments = await encodePendingAttachments('reply-attachment-picker'); await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/messages', { method:'POST', body: JSON.stringify({ message: $('reply').value, flow_id: $('reply-workflow').value || null, model: $('reply-model').value || null, ...(attachments.length ? { attachments } : {}) }) }); $('reply').value = ''; $('reply-attachment-picker').value = ''; renderPendingAttachments('reply-attachment-picker', 'reply-attachment-list'); await startRun(); state.eventAbort?.abort(); void startEventStream(); } catch (error) { $('reply-error').textContent = error.message; } });
    $('run-again').addEventListener('click', () => startRun().catch((error) => { $('reply-error').textContent = error.message; }));
    $('session-view-toggle').addEventListener('click', () => { state.showArchived = !state.showArchived; $('session-view-toggle').textContent = state.showArchived ? '当前' : '已归档'; $('session-view-toggle').title = state.showArchived ? '显示当前 Session' : '显示已归档 Session'; resetWorkbench(); });
    $('sync-sessions').addEventListener('click', () => syncSessions().catch((error) => { $('workbench-error').textContent = error.message; }));
    [['reply-mention-button', 'reply', '@'], ['reply-command-button', 'reply', '/']].forEach(([button, input, token]) => $(button).addEventListener('click', () => insertToken(input, token)));
    $('reply-attach-button').addEventListener('click', () => $('reply-attachment-picker').click());
    $('reply-attachment-picker').addEventListener('change', () => renderPendingAttachments('reply-attachment-picker', 'reply-attachment-list'));
    loadSessions(); loadFlows();
  </script>
</body>
</html>`
    .replace("__TOKEN__", token);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
