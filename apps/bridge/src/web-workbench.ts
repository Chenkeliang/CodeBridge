import { Hono } from "hono";
import type { SqliteEventStore } from "@codebridge/work-items";

export interface WebWorkbenchWorkflow {
  id: string;
  name: string;
}

export interface WebWorkbenchOptions {
  store: SqliteEventStore;
  token: string;
  agents?: string[];
  workflows?: WebWorkbenchWorkflow[];
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
  const agents = options.agents?.length ? options.agents : ["pi-investigator", "pi-developer"];
  const workflows = options.workflows ?? [];
  const token = JSON.stringify(options.token).replace(/</g, "\\u003c");
  const agentOptions = agents.map((agent) => `<option value="${escapeHtml(agent)}">${escapeHtml(agent)}</option>`).join("");
  const workflowOptions = [
    `<option value="">探索模式（不固定流程）</option>`,
    ...workflows.map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)} · ${escapeHtml(workflow.id)}</option>`),
  ].join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeBridge Workbench</title>
  <style>
    :root { color-scheme: light; --ink:#1e2523; --muted:#6d7773; --line:#dce2de; --paper:#f5f6f2; --panel:#ffffff; --accent:#23635b; --accent-soft:#e5f0ed; --warning:#9a6c27; }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100dvh; background:var(--paper); color:var(--ink); font:14px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    button, input, select, textarea { font:inherit; }
    button { cursor:pointer; border:0; }
    .shell { min-height:100dvh; display:grid; grid-template-columns:300px 1fr; }
    .sidebar { border-right:1px solid var(--line); background:#f1f3ef; padding:28px 18px; display:flex; flex-direction:column; gap:24px; }
    .brand { display:flex; align-items:center; justify-content:space-between; padding:0 8px; }
    .brand strong { letter-spacing:.08em; font-size:12px; text-transform:uppercase; }
    .brand span { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .inbox-head { display:flex; justify-content:space-between; align-items:center; padding:0 8px; }
    .inbox-head h2 { margin:0; font-size:12px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
    .new-button { background:var(--ink); color:#fff; border-radius:7px; padding:7px 10px; transition:transform .2s ease, background .2s ease; }
    .new-button:hover { background:var(--accent); transform:translateY(-1px); }
    .work-list { display:grid; gap:5px; overflow:auto; }
    .work-row { display:grid; gap:3px; text-align:left; padding:12px 10px; border-radius:8px; background:transparent; color:var(--ink); }
    .work-row:hover, .work-row.active { background:#e4e9e5; }
    .work-row strong { font-size:13px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .work-row small { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
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
    .grid { display:grid; grid-template-columns:minmax(0,1.35fr) minmax(260px,.65fr); gap:24px; align-items:start; }
    .timeline { min-height:330px; border-top:1px solid var(--line); }
    .timeline-empty { padding:42px 0; color:var(--muted); }
    .event { display:grid; grid-template-columns:116px 1fr; gap:18px; padding:14px 0; border-bottom:1px solid var(--line); }
    .event time { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .event-body strong { display:block; font-size:12px; letter-spacing:.04em; }
    .event-body pre { margin:5px 0 0; white-space:pre-wrap; word-break:break-word; color:var(--muted); font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .panel { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:18px; box-shadow:0 16px 35px -28px rgba(30,37,35,.5); }
    .panel h2 { margin:0 0 16px; font-size:13px; letter-spacing:.05em; }
    .form-grid { display:grid; gap:13px; }
    label { display:grid; gap:6px; color:var(--muted); font-size:12px; }
    input, select, textarea { width:100%; border:1px solid var(--line); background:#fbfcfa; border-radius:7px; padding:9px 10px; color:var(--ink); outline:none; transition:border .2s ease, box-shadow .2s ease; }
    input:focus, select:focus, textarea:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
    textarea { min-height:92px; resize:vertical; }
    .actions { display:flex; gap:8px; align-items:center; }
    .primary { background:var(--accent); color:#fff; border-radius:7px; padding:10px 13px; transition:transform .2s ease, filter .2s ease; }
    .primary:hover { filter:brightness(1.08); transform:translateY(-1px); }
    .secondary { background:#edf1ee; color:var(--ink); border-radius:7px; padding:10px 13px; }
    .error { color:#a14835; font-size:12px; min-height:18px; }
    .meta { display:grid; gap:8px; border-top:1px solid var(--line); margin-top:18px; padding-top:16px; color:var(--muted); font-size:12px; }
    .meta div { display:flex; justify-content:space-between; gap:12px; }
    .meta code { color:var(--ink); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width:800px) { .shell { grid-template-columns:1fr; } .sidebar { border-right:0; border-bottom:1px solid var(--line); padding:18px; } .work-list { max-height:190px; } .main { padding:26px 18px 44px; } .grid { grid-template-columns:1fr; } .workspace-top { flex-direction:column; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><strong>CodeBridge</strong><span>WORKBENCH / 01</span></div>
      <div class="inbox-head"><h2>Work items</h2><button class="new-button" id="new-work">New</button></div>
      <div class="work-list" id="work-list"><div class="empty">正在读取工作项…</div></div>
    </aside>
    <main class="main">
      <div class="workspace">
        <header class="workspace-top">
          <div><div class="eyebrow">Multi-project agent workspace</div><h1 id="title">开始一项工作</h1><p class="subline" id="subtitle">选择一个 Agent，固定或不固定一条 Workflow，然后用自然语言继续对话。</p></div>
          <span class="status" id="status">idle</span>
        </header>
        <div class="grid">
          <section><div class="timeline" id="timeline"><div class="timeline-empty">新建 WorkItem 后，这里会显示事实事件、Agent 输出、计划和审批节点。</div></div></section>
          <aside class="panel" id="composer-panel">
            <h2 id="composer-title">New WorkItem</h2>
            <form class="form-grid" id="work-form">
              <label>标题<input id="work-title" required placeholder="例如：排查权益未到账" /></label>
              <label>Agent<select id="agent">${agentOptions}</select></label>
              <label>Workflow<select id="workflow">${workflowOptions}</select></label>
              <label>模式<select id="mode"><option value="investigation">Investigation</option><option value="change">Change</option><option value="review">Review</option><option value="release">Release</option><option value="observe">Observe</option></select></label>
              <label>项目范围<input id="scope" placeholder="project-id，多个用逗号分隔" /></label>
              <label>第一句话<textarea id="message" required placeholder="描述目标、已知事实或你想先查什么"></textarea></label>
              <div class="error" id="error"></div>
              <div class="actions"><button class="primary" type="submit">创建并开始</button><button class="secondary" id="cancel-new" type="button">取消</button></div>
            </form>
            <div class="meta" id="meta" hidden></div>
            <form class="form-grid" id="reply-form" hidden>
              <label>继续对话<textarea id="reply" placeholder="补充事实、追问或调整下一步"></textarea></label>
              <div class="actions"><button class="primary" type="submit">发送消息</button><button class="secondary" id="run-again" type="button">再次运行</button></div>
            </form>
          </aside>
        </div>
      </div>
    </main>
  </div>
  <script>
    const TOKEN = __TOKEN__;
    const state = { selected: null, sequence: 0, timer: null };
    const $ = (id) => document.getElementById(id);
    const api = async (url, init = {}) => {
      const response = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(init.headers || {}) } });
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
      return response.status === 204 ? null : response.json();
    };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const label = (value) => ({ WORK_ITEM_CREATED:'创建', MESSAGE_RECEIVED:'消息', RUN_CREATED:'运行排队', RUN_STARTED:'运行开始', STEP_STARTED:'步骤开始', AGENT_EVENT:'Agent 事件', STEP_SUCCEEDED:'步骤完成', RUN_SUCCEEDED:'运行成功', RUN_FAILED:'运行失败', PROJECT_CANDIDATE_FOUND:'发现项目', APPROVAL_REQUESTED:'等待审批', APPROVAL_GRANTED:'审批通过', WORK_ITEM_COMPLETED:'工作完成' }[value] || value);
    async function loadItems() {
      try {
        const result = await api('/v1/work-items');
        const list = result.work_items || [];
        $('work-list').innerHTML = list.length ? list.map((item) => '<button class="work-row ' + (state.selected === item.id ? 'active' : '') + '" data-id="' + esc(item.id) + '"><strong>' + esc(item.title) + '</strong><small>' + esc(item.status) + ' · ' + esc(item.mode) + '</small></button>').join('') : '<div class="empty">还没有 WorkItem。点击 New 开始一次可恢复的对话。</div>';
        document.querySelectorAll('.work-row').forEach((button) => button.addEventListener('click', () => selectItem(button.dataset.id)));
      } catch (error) { $('work-list').innerHTML = '<div class="empty">无法读取：' + esc(error.message) + '</div>'; }
    }
    async function selectItem(id) {
      state.selected = id; state.sequence = 0; $('work-form').hidden = true; $('reply-form').hidden = false; $('composer-title').textContent = 'Conversation';
      await refreshItem(); loadItems();
      clearInterval(state.timer); state.timer = setInterval(refreshItem, 1200);
    }
    async function refreshItem() {
      if (!state.selected) return;
      try {
        const item = await api('/v1/work-items/' + encodeURIComponent(state.selected));
        $('title').textContent = item.title; $('subtitle').textContent = item.workflow_id ? 'Workflow ' + item.workflow_id + ' · Agent ' + item.agent_id : '探索模式 · Agent ' + item.agent_id; $('status').textContent = item.status; $('status').className = 'status ' + (item.status.includes('awaiting') ? 'waiting' : '');
        $('meta').hidden = false; $('meta').innerHTML = '<div><span>WorkItem</span><code>' + esc(item.id) + '</code></div><div><span>Agent</span><code>' + esc(item.agent_id) + '</code></div><div><span>范围</span><code>' + esc((item.workspace_scope || []).join(', ') || '未指定') + '</code></div>';
        const response = await fetch('/v1/work-items/' + encodeURIComponent(state.selected) + '/events?after_sequence=' + state.sequence, { headers: { authorization: 'Bearer ' + TOKEN } });
        const text = await response.text();
        const events = [...text.matchAll(/data: (\{.*\})/g)].map((match) => JSON.parse(match[1]));
        if (events.length) { state.sequence = events[events.length - 1].sequence; renderEvents(events); }
      } catch (error) { $('error').textContent = error.message; }
    }
    function renderEvents(events) { const target = $('timeline'); if (target.querySelector('.timeline-empty')) target.innerHTML = ''; target.insertAdjacentHTML('beforeend', events.map((event) => '<article class="event"><time>' + esc(new Date(event.occurred_at).toLocaleTimeString()) + '</time><div class="event-body"><strong>' + esc(label(event.type)) + '</strong><pre>' + esc(JSON.stringify(event.payload || {}, null, 2)) + '</pre></div></article>').join('')); target.scrollTop = target.scrollHeight; }
    async function startRun() { if (!state.selected) return; await api('/v1/work-items/' + encodeURIComponent(state.selected) + '/runs', { method:'POST', body: JSON.stringify({ mode: $('mode').value }) }); await refreshItem(); }
    $('work-form').addEventListener('submit', async (event) => { event.preventDefault(); $('error').textContent = ''; try { const scope = $('scope').value.split(',').map((value) => value.trim()).filter(Boolean); const item = await api('/v1/work-items', { method:'POST', body: JSON.stringify({ conversation_id: 'conv_' + crypto.randomUUID().replaceAll('-', ''), title: $('work-title').value, agent_id: $('agent').value, workflow_id: $('workflow').value || null, mode: $('mode').value, workspace_scope: scope, message: $('message').value }) }); await selectItem(item.id); await startRun(); } catch (error) { $('error').textContent = error.message; } });
    $('reply-form').addEventListener('submit', async (event) => { event.preventDefault(); if (!state.selected || !$('reply').value.trim()) return; try { await api('/v1/work-items/' + encodeURIComponent(state.selected) + '/messages', { method:'POST', body: JSON.stringify({ message: $('reply').value }) }); $('reply').value = ''; await startRun(); } catch (error) { $('error').textContent = error.message; } });
    $('run-again').addEventListener('click', () => startRun().catch((error) => { $('error').textContent = error.message; }));
    $('new-work').addEventListener('click', () => { state.selected = null; state.sequence = 0; clearInterval(state.timer); $('title').textContent = '开始一项工作'; $('subtitle').textContent = '选择一个 Agent，固定或不固定一条 Workflow，然后用自然语言继续对话。'; $('status').textContent = 'idle'; $('timeline').innerHTML = '<div class="timeline-empty">新建 WorkItem 后，这里会显示事实事件、Agent 输出、计划和审批节点。</div>'; $('work-form').hidden = false; $('reply-form').hidden = true; $('composer-title').textContent = 'New WorkItem'; loadItems(); });
    $('cancel-new').addEventListener('click', () => { if (state.selected) selectItem(state.selected); });
    loadItems();
  </script>
</body>
</html>`
    .replace("__TOKEN__", token);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
