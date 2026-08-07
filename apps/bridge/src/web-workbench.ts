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
}

export interface WebWorkbenchOptions {
  store: SqliteEventStore;
  token: string;
  agents?: string[];
  agentProfiles?: WebWorkbenchAgent[];
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
  const agents = options.agents ?? [];
  const agentProfiles: WebWorkbenchAgent[] = options.agentProfiles ?? agents.map((id) => ({ id, name: id }));
  const workflows = options.workflows ?? [];
  const token = JSON.stringify(options.token).replace(/</g, "\\u003c");
  const agentOptions = agentProfiles.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.name)}${agent.status ? ` · ${escapeHtml(agent.status)}` : ""}</option>`).join("");
  const workflowOptions = [
    `<option value="">Workflow · 自动发现</option>`,
    ...workflows.map((workflow) => `<option value="${escapeHtml(workflow.id)}">${escapeHtml(workflow.name)} · ${escapeHtml(workflow.id)}</option>`),
  ].join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeBridge Workbench</title>
  <style>
    :root { color-scheme: light; --ink:#1e2523; --muted:#6d7773; --line:#dce2de; --paper:#f5f6f2; --panel:#ffffff; --accent:#23635b; --accent-soft:#e5f0ed; --warning:#9a6c27; --shadow:0 24px 60px -42px rgba(30,37,35,.62); }
    * { box-sizing:border-box; }
    body { margin:0; min-height:100dvh; background:radial-gradient(circle at 75% 0%, #ffffff 0, transparent 38%), var(--paper); color:var(--ink); font:14px/1.55 "Avenir Next", "PingFang SC", ui-sans-serif, sans-serif; }
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
    .work-list { display:grid; gap:12px; overflow:auto; }
    .agent-group { display:grid; gap:4px; }
    .agent-group-head { display:flex; align-items:center; justify-content:space-between; padding:6px 8px; color:var(--ink); }
    .agent-group-head strong { font-size:13px; }
    .agent-new { background:transparent; color:var(--accent); font-size:16px; padding:0 4px; }
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
    .grid { display:grid; grid-template-columns:minmax(0,1fr); gap:24px; align-items:start; }
    .conversation-column { display:grid; gap:18px; min-width:0; }
    .timeline { min-height:330px; border-top:1px solid var(--line); }
    .timeline-empty { padding:42px 0; color:var(--muted); }
    .event { display:grid; grid-template-columns:116px 1fr; gap:18px; padding:14px 0; border-bottom:1px solid var(--line); }
    .event time { color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    .event-body strong { display:block; font-size:12px; letter-spacing:.04em; }
    .event-body pre { margin:5px 0 0; white-space:pre-wrap; word-break:break-word; color:var(--muted); font:12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
    .chat-composer { background:rgba(255,255,255,.94); border:1px solid var(--line); border-radius:16px; padding:12px; box-shadow:var(--shadow); }
    .composer-head { display:flex; align-items:center; justify-content:space-between; gap:16px; padding:2px 4px 10px; }
    .composer-head strong { font-size:14px; letter-spacing:.02em; }
    .composer-head span, .context-note { color:var(--muted); font-size:12px; }
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
    .context-note { display:flex; align-items:center; gap:7px; padding:3px 3px 0; }
    .context-note::before { content:"✦"; color:var(--accent); }
    .actions { display:flex; gap:8px; align-items:center; }
    .primary { background:var(--accent); color:#fff; border-radius:8px; padding:10px 13px; transition:transform .2s ease, filter .2s ease; }
    .primary:hover { filter:brightness(1.08); transform:translateY(-1px); }
    .secondary { background:#edf1ee; color:var(--ink); border-radius:8px; padding:10px 13px; }
    .error { color:#a14835; font-size:12px; min-height:18px; }
    .meta { display:grid; gap:8px; border-top:1px solid var(--line); margin-top:18px; padding-top:16px; color:var(--muted); font-size:12px; }
    .meta div { display:flex; justify-content:space-between; gap:12px; }
    .meta code { color:var(--ink); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; }
    @media (max-width:800px) { .shell { grid-template-columns:1fr; } .sidebar { border-right:0; border-bottom:1px solid var(--line); padding:18px; } .work-list { max-height:190px; } .main { padding:26px 18px 44px; } .workspace-top { flex-direction:column; } .composer-context { gap:5px; } .context-control, .context-chip { flex:1 1 auto; } }
  </style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand"><strong>CodeBridge</strong><span>WORKBENCH / 01</span></div>
      <div class="inbox-head"><h2>Agents</h2><button class="new-button" id="new-work">New session</button></div>
      <div class="work-list" id="work-list"><div class="empty">正在读取 Agent 会话…</div></div>
      <div class="inbox-head"><h2>Flows</h2></div>
      <div class="work-list" id="flow-list"><div class="empty">Flow 会在当前会话中自动发现或由你选择。</div></div>
    </aside>
    <main class="main">
      <div class="workspace">
        <header class="workspace-top">
          <div><div class="eyebrow">Multi-project agent workspace</div><h1 id="title">把问题交给 Agent</h1><p class="subline" id="subtitle">描述目标即可。Agent 会先理解目标，再决定合适的上下文与下一步。</p></div>
          <span class="status" id="status">idle</span>
        </header>
        <div class="grid">
          <section class="conversation-column">
            <div class="timeline" id="timeline"><div class="timeline-empty">发送第一句话后，这里会显示对话进展、Agent 输出、计划和需要你确认的事项。</div></div>
            <form class="chat-composer form-grid" id="work-form">
              <div class="composer-head"><strong id="composer-title">新对话</strong><span>自然语言输入</span></div>
              <div class="composer-context">
                <select class="context-control" id="agent" aria-label="Agent"><option value="">Agent · 自动选择</option>${agentOptions}</select>
                <select class="context-control" id="mode" aria-label="模式"><option value="auto">模式 · Agent 判断</option></select>
                <select class="context-control" id="workflow" aria-label="Workflow">${workflowOptions}</select>
                <span class="context-chip" id="model-chip">模型 · Agent 默认</span>
                <span class="context-chip" id="workspace-chip">工作空间 · 自动发现</span>
              </div>
              <div class="input-shell">
                <div class="composer-tools"><button class="tool-button" id="attach-button" type="button" aria-label="添加上下文">＋</button></div>
                <textarea class="message-input" id="message" required placeholder="输入任务… 试试 @资源 或 /命令"></textarea>
                <div class="input-actions"><button class="tool-button" id="mention-button" type="button" aria-label="引用上下文">@</button><button class="tool-button" id="command-button" type="button" aria-label="插入命令">/</button><button class="send-button" type="submit" aria-label="发送">↑</button></div>
              </div>
              <div class="context-note">Agent 会先理解目标，再决定合适的上下文与下一步；周边选项只是可选提示。</div>
              <div class="error" id="error"></div>
            </form>
            <form class="chat-composer form-grid" id="reply-form" hidden>
              <div class="composer-head"><strong>继续对话</strong><span>补充事实或追问</span></div>
              <div class="composer-context">
                <span class="context-chip" id="reply-mode-chip">模式 · Agent 判断</span><select class="context-control" id="reply-workflow" aria-label="Workflow">${workflowOptions}</select><span class="context-chip" id="reply-workspace-chip">工作空间 · 自动发现</span><span class="context-chip" id="reply-model-chip">模型 · Agent 默认</span>
              </div>
              <div class="input-shell">
                <div class="composer-tools"><button class="tool-button" id="reply-attach-button" type="button" aria-label="添加上下文">＋</button></div>
                <textarea class="message-input" id="reply" placeholder="补充背景、约束或新的要求，告诉 Agent 下一步如何调整"></textarea>
                <div class="input-actions"><button class="tool-button" id="reply-mention-button" type="button" aria-label="引用上下文">@</button><button class="tool-button" id="reply-command-button" type="button" aria-label="插入命令">/</button><button class="send-button" type="submit" aria-label="发送">↑</button></div>
              </div>
              <div class="error" id="reply-error"></div>
              <div class="actions"><button class="secondary" id="run-again" type="button">再次运行</button></div>
            </form>
          </section>
        </div>
      </div>
    </main>
  </div>
  <script>
    const TOKEN = __TOKEN__;
    const state = { selected: null, sequence: 0, timer: null, session: null };
    const $ = (id) => document.getElementById(id);
    const api = async (url, init = {}) => {
      const response = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(init.headers || {}) } });
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
      return response.status === 204 ? null : response.json();
    };
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const label = (value) => ({ WORK_ITEM_CREATED:'创建', MESSAGE_RECEIVED:'消息', RUN_CREATED:'运行排队', RUN_STARTED:'运行开始', STEP_STARTED:'步骤开始', AGENT_EVENT:'Agent 事件', STEP_SUCCEEDED:'步骤完成', RUN_SUCCEEDED:'运行成功', RUN_FAILED:'运行失败', PROJECT_CANDIDATE_FOUND:'发现资源', APPROVAL_REQUESTED:'需要确认', APPROVAL_GRANTED:'已确认', WORK_ITEM_COMPLETED:'工作完成' }[value] || value);
    const modeLabel = (value) => ({ auto:'Agent 判断中', investigation:'调查', change:'修改', review:'Review', release:'发布', observe:'观察' }[value] || value || '待判断');
    const insertToken = (id, token) => { const input = $(id); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; input.value = input.value.slice(0, start) + token + input.value.slice(end); input.focus(); input.selectionStart = input.selectionEnd = start + token.length; };
    function applyFlows(flows) { const options = '<option value="">Workflow · 自动发现</option>' + flows.map((flow) => '<option value="' + esc(flow.flow_id) + '">' + esc(flow.name || flow.flow_id) + ' · ' + esc(flow.flow_id) + '</option>').join(''); $('workflow').innerHTML = options; $('reply-workflow').innerHTML = options; }
    async function loadFlows() { try { const result = await api('/v1/flows'); const flows = result.flows || []; applyFlows(flows); $('flow-list').innerHTML = flows.length ? flows.map((flow) => '<button class="work-row flow-row" data-flow="' + esc(flow.flow_id) + '"><strong>' + esc(flow.name || flow.flow_id) + '</strong><small>' + esc(flow.status) + ' · ' + esc(flow.kind) + '</small></button>').join('') : '<div class="empty">当前没有已登记的 Flow；在 Session 中可以自动发现。</div>'; document.querySelectorAll('.flow-row').forEach((button) => button.addEventListener('click', () => { $('workflow').value = button.dataset.flow; $('reply-workflow').value = button.dataset.flow; })); } catch (error) { $('flow-list').innerHTML = '<div class="empty">无法读取 Flow：' + esc(error.message) + '</div>'; } }
    async function loadSessions() {
      try {
        const result = await api('/v1/sessions');
        const sessions = result.sessions || [];
        const groups = sessions.reduce((map, session) => { (map[session.agent_id] ||= []).push(session); return map; }, {});
        const agentIds = [...new Set([${JSON.stringify(agentProfiles.map((agent) => agent.id))}, ...Object.keys(groups)].flat())];
        const agentLabels = ${JSON.stringify(Object.fromEntries(agentProfiles.map((agent) => [agent.id, `${agent.name}${agent.status ? ` · ${agent.status}` : ''}`])))};
        $('work-list').innerHTML = agentIds.map((agentId) => '<section class="agent-group"><div class="agent-group-head"><strong>' + esc(agentLabels[agentId] || agentId) + '</strong><button class="agent-new" data-agent="' + esc(agentId) + '" aria-label="新建会话">＋</button></div>' + ((groups[agentId] || []).map((session) => '<button class="work-row ' + (state.selected === session.session_id ? 'active' : '') + '" data-id="' + esc(session.session_id) + '"><strong>' + esc(session.title || '新会话') + '</strong><small>' + esc(session.status) + ' · ' + esc(session.cwd || '工作空间自动发现') + '</small></button>').join('') || '<div class="empty">还没有会话</div>') + '</section>').join('');
        document.querySelectorAll('.work-row').forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.id)));
        document.querySelectorAll('.agent-new').forEach((button) => button.addEventListener('click', () => newSession(button.dataset.agent)));
      } catch (error) { $('work-list').innerHTML = '<div class="empty">无法读取：' + esc(error.message) + '</div>'; }
    }
    async function newSession(agentId) {
      try {
        const session = await api('/v1/sessions', { method:'POST', body: JSON.stringify({ agent_id: agentId || $('agent').value || ${JSON.stringify(agents[0] || '')} }) });
        await selectSession(session.session_id);
      } catch (error) { $('error').textContent = error.message; }
    }
    async function selectSession(id) {
      state.selected = id; state.sequence = 0; state.session = null; $('work-form').hidden = true; $('reply-form').hidden = false; $('composer-title').textContent = 'Session';
      await refreshSession(); loadSessions();
      clearInterval(state.timer); state.timer = setInterval(refreshSession, 1200);
    }
    async function refreshSession() {
      if (!state.selected) return;
      try {
        const session = await api('/v1/sessions/' + encodeURIComponent(state.selected));
        state.session = session;
        const agent = session.agent_id || '自动选择';
        const scope = session.cwd || '';
        $('title').textContent = session.title || 'Session'; $('subtitle').textContent = 'Agent ' + agent + ' · ' + (session.status || 'idle'); $('status').textContent = session.status || 'idle'; $('status').className = 'status ' + (session.status === 'waiting' ? 'waiting' : '');
        $('mode').value = 'auto'; $('agent').value = agent; $('agent').disabled = true; $('workflow').value = session.flow_id || ''; $('reply-workflow').value = session.flow_id || '';
        $('workspace-chip').textContent = scope ? '工作空间 · ' + scope : '工作空间 · Agent 自动发现';
        $('model-chip').textContent = '模型 · Agent 默认';
        $('reply-mode-chip').textContent = '模式 · Agent 判断';
        $('reply-workspace-chip').textContent = scope ? '工作空间 · ' + scope : '工作空间 · Agent 自动发现';
        $('reply-model-chip').textContent = '模型 · Agent 默认';
        const response = await fetch('/v1/sessions/' + encodeURIComponent(state.selected) + '/events?after_sequence=' + state.sequence, { headers: { authorization: 'Bearer ' + TOKEN } });
        const text = await response.text();
        const events = [...text.matchAll(/data: (\{.*\})/g)].map((match) => JSON.parse(match[1]));
        if (events.length) { state.sequence = events[events.length - 1].sequence; renderEvents(events); }
      } catch (error) { $('error').textContent = error.message; $('reply-error').textContent = error.message; }
    }
    function renderEvents(events) { const target = $('timeline'); if (target.querySelector('.timeline-empty')) target.innerHTML = ''; target.insertAdjacentHTML('beforeend', events.map((event) => '<article class="event"><time>' + esc(new Date(event.occurred_at).toLocaleTimeString()) + '</time><div class="event-body"><strong>' + esc(label(event.type)) + '</strong><pre>' + esc(JSON.stringify(event.payload || {}, null, 2)) + '</pre></div></article>').join('')); target.scrollTop = target.scrollHeight; }
    async function startRun() { if (!state.selected) return; await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/runs', { method:'POST', body: JSON.stringify({ flow_id: $('reply-workflow').value || $('workflow').value || null, mode: 'auto' }) }); await refreshSession(); }
    $('work-form').addEventListener('submit', async (event) => { event.preventDefault(); $('error').textContent = ''; try { await newSession($('agent').value); await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/messages', { method:'POST', body: JSON.stringify({ message: $('message').value, flow_id: $('workflow').value || null }) }); $('message').value = ''; await startRun(); } catch (error) { $('error').textContent = error.message; } });
    $('reply-form').addEventListener('submit', async (event) => { event.preventDefault(); $('reply-error').textContent = ''; if (!state.selected || !$('reply').value.trim()) return; try { await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/messages', { method:'POST', body: JSON.stringify({ message: $('reply').value, flow_id: $('reply-workflow').value || null }) }); $('reply').value = ''; await startRun(); } catch (error) { $('reply-error').textContent = error.message; } });
    $('run-again').addEventListener('click', () => startRun().catch((error) => { $('reply-error').textContent = error.message; }));
    [['mention-button', 'message', '@'], ['command-button', 'message', '/'], ['attach-button', 'message', '@'], ['reply-mention-button', 'reply', '@'], ['reply-command-button', 'reply', '/'], ['reply-attach-button', 'reply', '@']].forEach(([button, input, token]) => $(button).addEventListener('click', () => insertToken(input, token)));
    $('new-work').addEventListener('click', () => { state.selected = null; state.session = null; state.sequence = 0; clearInterval(state.timer); $('title').textContent = '把问题交给 Agent'; $('subtitle').textContent = '描述目标即可。Agent 会先理解目标，再决定合适的上下文与下一步。'; $('status').textContent = 'idle'; $('timeline').innerHTML = '<div class="timeline-empty">发送第一句话后，这里会显示对话进展、Agent 输出、计划和需要你确认的事项。</div>'; $('work-form').hidden = false; $('reply-form').hidden = true; $('composer-title').textContent = '新 Session'; $('agent').disabled = false; $('agent').value = ''; $('mode').value = 'auto'; $('workflow').value = ''; $('model-chip').textContent = '模型 · Agent 默认'; $('workspace-chip').textContent = '工作空间 · 自动发现'; loadSessions(); });
    loadSessions(); loadFlows();
  </script>
</body>
</html>`
    .replace("__TOKEN__", token);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
