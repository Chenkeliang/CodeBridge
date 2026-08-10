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
  const modelOptions = `<option value="">模型 · Agent 默认</option>${[...new Set(agentProfiles.flatMap((agent) => agent.models ?? []))].map((model) => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join("")}`;
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
    .session-actions { display:flex; align-items:center; flex-wrap:wrap; justify-content:flex-end; gap:6px; }
    .session-action { border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--muted); padding:6px 9px; font-size:12px; }
    .session-action:hover { border-color:var(--accent); color:var(--accent); }
    .directory-panel { display:grid; gap:10px; border:1px solid var(--line); border-radius:12px; background:#fff; padding:14px; }
    .directory-head { display:flex; justify-content:space-between; gap:12px; align-items:center; }
    .directory-head strong { font-size:13px; }
    .directory-list { display:grid; gap:6px; }
    .directory-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:7px 9px; border-radius:7px; background:#f5f7f5; color:var(--muted); font:11px ui-monospace, SFMono-Regular, Menlo, monospace; word-break:break-all; }
    .directory-remove { flex:0 0 auto; border:1px solid var(--line); border-radius:6px; background:#fff; color:var(--muted); padding:3px 6px; font-size:11px; }
    .directory-remove:hover { border-color:#a14835; color:#a14835; }
    .directory-add { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:7px; }
    .grid { display:grid; grid-template-columns:minmax(0,1fr); gap:24px; align-items:start; }
    .conversation-column { display:grid; gap:18px; min-width:0; }
    .timeline { min-height:330px; border-top:1px solid var(--line); }
    .timeline-toolbar { display:flex; flex-wrap:wrap; gap:5px; padding:10px 0; border-bottom:1px solid var(--line); }
    .timeline-filter { border:1px solid var(--line); border-radius:7px; background:#fff; color:var(--muted); padding:5px 9px; font-size:12px; }
    .timeline-filter.active, .timeline-filter:hover { background:var(--accent-soft); border-color:var(--accent); color:var(--accent); }
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
    .workspace-control { min-width:220px; }
    .workspace-authorize { background:var(--accent-soft); color:var(--accent); border-color:transparent; cursor:pointer; }
    .workspace-authorize:hover { border-color:var(--accent); }
    .context-control { outline:none; }
    .context-control:focus { border-color:var(--accent); box-shadow:0 0 0 3px var(--accent-soft); }
    .context-chip { display:inline-flex; align-items:center; flex:0 0 auto; }
    .context-note { display:flex; align-items:center; gap:7px; padding:3px 3px 0; }
    .context-note::before { content:"✦"; color:var(--accent); }
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
          <div class="session-actions" id="session-actions" hidden><button class="session-action" id="session-resume" type="button">继续</button><button class="session-action" id="session-fork" type="button">分支</button><button class="session-action" id="session-directories" type="button">目录</button><button class="session-action" id="session-close" type="button">关闭</button><button class="session-action" id="session-delete" type="button">删除</button><span class="status" id="status">idle</span></div>
        </header>
        <div class="grid">
          <section class="conversation-column">
            <section class="directory-panel" id="directory-panel" hidden>
              <div class="directory-head"><strong>Session context</strong><span class="context-note">附加目录会在下一次运行时生效</span></div>
              <div class="directory-list" id="directory-list"><div class="empty">当前没有附加目录。</div></div>
              <div class="directory-add"><input id="additional-directory" aria-label="附加目录" placeholder="输入需要授权的本机目录路径" autocomplete="off" /><button class="secondary" id="add-directory" type="button">添加目录</button></div>
              <div class="error" id="directory-error"></div>
            </section>
            <div class="timeline-toolbar" id="timeline-toolbar"><button class="timeline-filter active" data-view="all" type="button">全部</button><button class="timeline-filter" data-view="plan" type="button">计划</button><button class="timeline-filter" data-view="approval" type="button">审批</button><button class="timeline-filter" data-view="evidence" type="button">证据</button><button class="timeline-filter" data-view="diff" type="button">Diff</button><button class="timeline-filter" data-view="test" type="button">测试</button></div><div class="timeline" id="timeline"><div class="timeline-empty">发送第一句话后，这里会显示对话进展、Agent 输出、计划和需要你确认的事项。</div></div>
            <form class="chat-composer form-grid" id="work-form">
              <div class="composer-head"><strong id="composer-title">新对话</strong><span>自然语言输入</span></div>
              <div class="composer-context">
                <select class="context-control" id="agent" aria-label="Agent"><option value="">Agent · 自动选择</option>${agentOptions}</select>
                <select class="context-control" id="mode" aria-label="模式"><option value="auto">模式 · Agent 判断</option></select>
                <select class="context-control" id="workflow" aria-label="Workflow">${workflowOptions}</select>
                <input class="context-control workspace-control" id="workspace" aria-label="Folder / 工作目录" placeholder="Folder / 工作目录（可选）" autocomplete="off" />
                <button class="context-control workspace-authorize" id="workspace-authorize" type="button">授权</button>
                <select class="context-control" id="model" aria-label="模型">${modelOptions}</select>
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
                <span class="context-chip" id="reply-mode-chip">模式 · Agent 判断</span><select class="context-control" id="reply-workflow" aria-label="Workflow">${workflowOptions}</select><span class="context-chip" id="reply-workspace-chip">工作空间 · 自动发现</span><select class="context-control" id="reply-model" aria-label="模型">${modelOptions}</select>
              </div>
              <div class="input-shell">
                <div class="composer-tools"><button class="tool-button" id="reply-attach-button" type="button" aria-label="添加上下文">＋</button></div>
                <textarea class="message-input" id="reply" placeholder="补充背景、约束或新的要求，告诉 Agent 下一步如何调整"></textarea>
                <div class="input-actions"><button class="tool-button" id="reply-mention-button" type="button" aria-label="引用上下文">@</button><button class="tool-button" id="reply-command-button" type="button" aria-label="插入命令">/</button><button class="send-button" type="submit" aria-label="发送">↑</button></div>
              </div>
              <div class="error" id="reply-error"></div>
              <div class="actions"><button class="secondary" id="run-again" type="button">再次运行</button><button class="secondary" id="save-flow" type="button" hidden>保存为 Workflow Candidate</button><button class="secondary" id="accept-project" type="button" hidden>确认登记发现的资源</button><button class="secondary" id="approve-run" type="button" hidden>批准本次操作</button><button class="secondary" id="reject-run" type="button" hidden>拒绝本次操作</button></div>
            </form>
          </section>
        </div>
      </div>
    </main>
  </div>
  <script>
    const TOKEN = __TOKEN__;
    const state = { selected: null, sequence: 0, timer: null, eventAbort: null, session: null, ephemeralFlow: null, projectCandidateId: null, approval: null, view: 'all' };
    const $ = (id) => document.getElementById(id);
    const api = async (url, init = {}) => {
      const response = await fetch(url, { ...init, headers: { authorization: 'Bearer ' + TOKEN, 'content-type': 'application/json', ...(init.headers || {}) } });
      if (!response.ok) throw new Error((await response.text()) || ('HTTP ' + response.status));
      return response.status === 204 ? null : response.json();
    };
    const agentModels = ${JSON.stringify(Object.fromEntries(agentProfiles.map((agent) => [agent.id, agent.models ?? []])))};
    const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[char]));
    const label = (value) => ({ WORK_ITEM_CREATED:'创建', MESSAGE_RECEIVED:'消息', RUN_CREATED:'运行排队', RUN_STARTED:'运行开始', STEP_STARTED:'步骤开始', STEP_SKIPPED:'步骤跳过', AGENT_EVENT:'Agent 事件', FLOW_PROPOSED:'流程建议', FLOW_SAVED_AS_CANDIDATE:'流程已保存', STEP_SUCCEEDED:'步骤完成', RUN_SUCCEEDED:'运行成功', RUN_FAILED:'运行失败', PROJECT_CANDIDATE_FOUND:'发现资源', APPROVAL_REQUESTED:'需要确认', APPROVAL_GRANTED:'已确认', APPROVAL_REJECTED:'已拒绝', BRANCH_SELECTED:'分支选择', WORK_ITEM_COMPLETED:'工作完成' }[value] || value);
    const modeLabel = (value) => ({ auto:'Agent 判断中', investigation:'调查', change:'修改', review:'Review', release:'发布', observe:'观察' }[value] || value || '待判断');
    const insertToken = (id, token) => { const input = $(id); const start = input.selectionStart ?? input.value.length; const end = input.selectionEnd ?? start; input.value = input.value.slice(0, start) + token + input.value.slice(end); input.focus(); input.selectionStart = input.selectionEnd = start + token.length; };
    function applyFlows(flows) { const options = '<option value="">Workflow · 自动发现</option>' + flows.map((flow) => '<option value="' + esc(flow.flow_id) + '">' + esc(flow.name || flow.flow_id) + ' · ' + esc(flow.flow_id) + '</option>').join(''); $('workflow').innerHTML = options; $('reply-workflow').innerHTML = options; }
    async function loadFlows() { try { const result = await api('/v1/flows'); const flows = result.flows || []; applyFlows(flows); $('flow-list').innerHTML = flows.length ? flows.map((flow) => '<div class="flow-row-wrap"><button class="work-row flow-row" data-flow="' + esc(flow.flow_id) + '"><strong>' + esc(flow.name || flow.flow_id) + '</strong><small>' + esc(flow.status) + ' · ' + esc(flow.kind) + '</small></button>' + (flow.status === 'candidate' ? '<button class="flow-review" data-review-flow="' + esc(flow.flow_id) + '" type="button">审核</button>' : '') + '</div>').join('') : '<div class="empty">当前没有已登记的 Flow；在 Session 中可以自动发现。</div>'; document.querySelectorAll('.flow-row').forEach((button) => button.addEventListener('click', () => { $('workflow').value = button.dataset.flow; $('reply-workflow').value = button.dataset.flow; })); document.querySelectorAll('.flow-review').forEach((button) => button.addEventListener('click', () => reviewFlow(button.dataset.reviewFlow).catch((error) => { $('reply-error').textContent = error.message; }))); } catch (error) { $('flow-list').innerHTML = '<div class="empty">无法读取 Flow：' + esc(error.message) + '</div>'; } }
    async function reviewFlow(flowId) { const decision = window.confirm('发布这个 Workflow Candidate？\n取消将保留 Candidate 不变。') ? 'approve' : 'reject'; const gitRevision = decision === 'approve' ? window.prompt('输入已审核的 Git revision') : null; if (decision === 'approve' && !gitRevision) return; await api('/v1/flows/' + encodeURIComponent(flowId) + '/review', { method:'POST', body: JSON.stringify({ decision, ...(gitRevision ? { git_revision: gitRevision } : {}) }) }); await loadFlows(); }
    async function loadSessions() {
      try {
        const result = await api('/v1/sessions?import=true');
        const sessions = result.sessions || [];
        const groups = sessions.reduce((map, session) => { (map[session.agent_id] ||= []).push(session); return map; }, {});
        const agentIds = [...new Set([${JSON.stringify(agentProfiles.map((agent) => agent.id))}, ...Object.keys(groups)].flat())];
        const agentLabels = ${JSON.stringify(Object.fromEntries(agentProfiles.map((agent) => [agent.id, `${agent.name}${agent.status ? ` · ${agent.status}` : ''}`])))};
        $('work-list').innerHTML = agentIds.map((agentId) => '<section class="agent-group"><div class="agent-group-head"><strong>' + esc(agentLabels[agentId] || agentId) + '</strong><button class="agent-new" data-agent="' + esc(agentId) + '" aria-label="新建会话">＋</button></div>' + ((groups[agentId] || []).map((session) => '<button class="work-row ' + (state.selected === session.session_id ? 'active' : '') + '" data-id="' + esc(session.session_id) + '"><strong>' + esc(session.title || '新会话') + '</strong><small>' + esc(session.status) + ' · ' + esc(session.cwd || '工作空间自动发现') + '</small></button>').join('') || '<div class="empty">还没有会话</div>') + '</section>').join('');
        document.querySelectorAll('#work-list .work-row').forEach((button) => button.addEventListener('click', () => selectSession(button.dataset.id)));
        document.querySelectorAll('.agent-new').forEach((button) => button.addEventListener('click', () => { void newSession(button.dataset.agent).catch((error) => { $('error').textContent = error.message; }); }));
      } catch (error) { $('work-list').innerHTML = '<div class="empty">无法读取：' + esc(error.message) + '</div>'; }
    }
    async function newSession(agentId) {
      const cwd = $('workspace').value.trim();
      const session = await api('/v1/sessions', { method:'POST', body: JSON.stringify({ agent_id: agentId || $('agent').value || ${JSON.stringify(agents[0] || '')}, model: $('model').value || null, ...(cwd ? { cwd } : {}) }) });
      await selectSession(session.session_id);
    }
    async function selectSession(id) {
      state.eventAbort?.abort(); state.selected = id; state.sequence = 0; state.session = null; state.ephemeralFlow = null; state.projectCandidateId = null; state.approval = null; $('save-flow').hidden = true; $('accept-project').hidden = true; $('approve-run').hidden = true; $('reject-run').hidden = true; $('directory-panel').hidden = true; $('directory-error').textContent = ''; $('work-form').hidden = true; $('reply-form').hidden = false; $('session-actions').hidden = false; $('composer-title').textContent = 'Session';
      await refreshSession(true); void startEventStream(); loadSessions();
      clearInterval(state.timer); state.timer = setInterval(() => { void refreshSession(); }, 1200);
    }
    async function refreshSession(readEvents = false) {
      if (!state.selected) return;
      try {
        const session = await api('/v1/sessions/' + encodeURIComponent(state.selected));
        state.session = session;
        const agent = session.agent_id || '自动选择';
        const scope = session.cwd || '';
        $('title').textContent = session.title || 'Session'; $('subtitle').textContent = 'Agent ' + agent + ' · ' + (session.status || 'idle'); $('status').textContent = session.status || 'idle'; $('status').className = 'status ' + (session.status === 'waiting' ? 'waiting' : '');
        $('session-resume').hidden = session.status !== 'closed';
        $('session-close').hidden = session.status === 'closed';
        $('mode').value = 'auto'; $('agent').value = agent; $('agent').disabled = true; $('workflow').value = session.flow_id || ''; $('reply-workflow').value = session.flow_id || ''; applyModels(agent); $('model').value = session.model || ''; $('reply-model').value = session.model || '';
         $('workspace').value = '';
         $('workspace-chip').textContent = scope ? '工作空间 · ' + scope : '工作空间 · Agent 自动发现';
         $('reply-mode-chip').textContent = '模式 · Agent 判断';
         $('reply-workspace-chip').textContent = scope ? '工作空间 · ' + scope : '工作空间 · Agent 自动发现';
         renderDirectories(session);
        if (readEvents) {
          const response = await fetch('/v1/sessions/' + encodeURIComponent(state.selected) + '/events?after_sequence=' + state.sequence, { headers: { authorization: 'Bearer ' + TOKEN } });
          const text = await response.text();
          const events = [...text.matchAll(/data: (\{.*\})/g)].map((match) => JSON.parse(match[1]));
          if (events.length) { state.sequence = events[events.length - 1].sequence; renderEvents(events); }
        }
      } catch (error) { $('error').textContent = error.message; $('reply-error').textContent = error.message; }
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
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            const data = block.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
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
    const eventView = (type) => ({ FLOW_PROPOSED:'plan', PLAN_VALIDATED:'plan', STEP_STARTED:'plan', STEP_SUCCEEDED:'plan', BRANCH_SELECTED:'plan', APPROVAL_REQUESTED:'approval', APPROVAL_GRANTED:'approval', PROJECT_CANDIDATE_FOUND:'evidence', ARTIFACT_CREATED:'evidence', DIFF_CREATED:'diff', GIT_DIFF:'diff', TEST_STARTED:'test', TEST_SUCCEEDED:'test', TEST_FAILED:'test', VERIFICATION_COMPLETED:'test' }[type] || 'all');
    function applyView() { document.querySelectorAll('.event').forEach((event) => { event.hidden = state.view !== 'all' && event.dataset.view !== state.view; }); document.querySelectorAll('.timeline-filter').forEach((button) => button.classList.toggle('active', button.dataset.view === state.view)); }
    function renderEvents(events) {
      const target = $('timeline');
      if (target.querySelector('.timeline-empty')) target.innerHTML = '';
      target.insertAdjacentHTML('beforeend', events.map((event) => '<article class="event" data-view="' + esc(eventView(event.type)) + '"><time>' + esc(new Date(event.occurred_at).toLocaleTimeString()) + '</time><div class="event-body"><strong>' + esc(label(event.type)) + '</strong><pre>' + esc(JSON.stringify(event.payload || {}, null, 2)) + '</pre></div></article>').join(''));
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
      applyView();
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
      } catch (error) { $('reply-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    $('session-resume').addEventListener('click', async () => {
      if (!state.selected) return;
      try { await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/resume', { method:'POST', body: '{}' }); await refreshSession(); loadSessions(); }
      catch (error) { $('reply-error').textContent = error.message; }
    });
    $('session-fork').addEventListener('click', async () => {
      if (!state.selected) return;
      try { const forked = await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/fork', { method:'POST', body: JSON.stringify({}) }); await selectSession(forked.session_id); }
      catch (error) { $('reply-error').textContent = error.message; }
    });
    $('session-close').addEventListener('click', async () => {
      if (!state.selected) return;
      try { await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/close', { method:'POST', body: '{}' }); await refreshSession(); loadSessions(); }
      catch (error) { $('reply-error').textContent = error.message; }
    });
    $('session-delete').addEventListener('click', async () => {
      if (!state.selected || !window.confirm('删除当前 Session？')) return;
      try { await api('/v1/sessions/' + encodeURIComponent(state.selected), { method:'DELETE' }); $('new-work').click(); }
      catch (error) { $('reply-error').textContent = error.message; }
    });
    $('session-directories').addEventListener('click', () => {
      $('directory-panel').hidden = !$('directory-panel').hidden;
      if (!$('directory-panel').hidden) $('additional-directory').focus();
    });
    $('add-directory').addEventListener('click', () => addDirectory());
    $('additional-directory').addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void addDirectory(); } });
    document.querySelectorAll('.timeline-filter').forEach((button) => button.addEventListener('click', () => { state.view = button.dataset.view || 'all'; applyView(); }));
    function applyModels(agentId) { const models = agentModels[agentId] || []; const options = '<option value="">模型 · Agent 默认</option>' + models.map((model) => '<option value="' + esc(model) + '">' + esc(model) + '</option>').join(''); $('model').innerHTML = options; $('reply-model').innerHTML = options; }
    $('agent').addEventListener('change', () => applyModels($('agent').value));
    async function startRun() { if (!state.selected) return; await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/runs', { method:'POST', body: JSON.stringify({ flow_id: $('reply-workflow').value || $('workflow').value || null, model: $('reply-model').value || $('model').value || null, mode: 'auto' }) }); await refreshSession(); }
    $('work-form').addEventListener('submit', async (event) => { event.preventDefault(); $('error').textContent = ''; try { await newSession($('agent').value); await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/messages', { method:'POST', body: JSON.stringify({ message: $('message').value, flow_id: $('workflow').value || null, model: $('model').value || null }) }); $('message').value = ''; await startRun(); } catch (error) { $('error').textContent = error.message; } });
    $('reply-form').addEventListener('submit', async (event) => { event.preventDefault(); $('reply-error').textContent = ''; if (!state.selected || !$('reply').value.trim()) return; try { await api('/v1/sessions/' + encodeURIComponent(state.selected) + '/messages', { method:'POST', body: JSON.stringify({ message: $('reply').value, flow_id: $('reply-workflow').value || null, model: $('reply-model').value || null }) }); $('reply').value = ''; await startRun(); } catch (error) { $('reply-error').textContent = error.message; } });
    $('run-again').addEventListener('click', () => startRun().catch((error) => { $('reply-error').textContent = error.message; }));
    [['mention-button', 'message', '@'], ['command-button', 'message', '/'], ['attach-button', 'message', '@'], ['reply-mention-button', 'reply', '@'], ['reply-command-button', 'reply', '/'], ['reply-attach-button', 'reply', '@']].forEach(([button, input, token]) => $(button).addEventListener('click', () => insertToken(input, token)));
    $('workspace-authorize').addEventListener('click', async () => {
      const input = $('workspace');
      const path = input.value.trim();
      $('error').textContent = '';
      if (!path) { input.focus(); return; }
      const button = $('workspace-authorize');
      button.disabled = true;
      try {
        const result = await api('/v1/directories/authorize', { method:'POST', body: JSON.stringify({ path }) });
        if (!result.ok) throw new Error(result.error || '工作目录授权失败');
        input.value = result.path || path;
      } catch (error) { $('error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    $('new-work').addEventListener('click', () => { state.eventAbort?.abort(); state.selected = null; state.session = null; state.sequence = 0; state.ephemeralFlow = null; state.projectCandidateId = null; state.approval = null; state.view = 'all'; clearInterval(state.timer); $('title').textContent = '把问题交给 Agent'; $('subtitle').textContent = '描述目标即可。Agent 会先理解目标，再决定合适的上下文与下一步。'; $('status').textContent = 'idle'; $('session-actions').hidden = true; $('directory-panel').hidden = true; $('directory-list').innerHTML = '<div class="empty">当前没有附加目录。</div>'; $('directory-error').textContent = ''; $('additional-directory').value = ''; $('timeline').innerHTML = '<div class="timeline-empty">发送第一句话后，这里会显示对话进展、Agent 输出、计划和需要你确认的事项。</div>'; $('work-form').hidden = false; $('reply-form').hidden = true; $('composer-title').textContent = '新 Session'; $('agent').disabled = false; $('agent').value = ''; $('mode').value = 'auto'; $('workflow').value = ''; $('workspace').value = ''; $('model').value = ''; $('reply-model').value = ''; $('workspace-chip').textContent = '工作空间 · 自动发现'; $('error').textContent = ''; $('save-flow').hidden = true; $('accept-project').hidden = true; $('approve-run').hidden = true; $('reject-run').hidden = true; applyModels(''); applyView(); loadSessions(); });
    loadSessions(); loadFlows();
  </script>
</body>
</html>`
    .replace("__TOKEN__", token);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
