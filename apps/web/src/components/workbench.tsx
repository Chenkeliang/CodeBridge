import { isValidElement, memo, useCallback, useEffect, useMemo, useRef, useState, type ClipboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  FileText,
  FolderOpen,
  Gauge,
  LoaderCircle,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  ShieldAlert,
  Sun,
  Terminal,
  Trash2,
  Wrench,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { BrandAgentIcon } from "@/components/brand-agent-icon";
import { MermaidDiagram } from "@/components/mermaid-diagram";
import { PixelMark } from "@/components/pixel-mark";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { api, streamSessionEvents } from "@/lib/api";
import { describeTool, reduceConversationEvents, type ApprovalProjection, type ConversationProjection, type ToolProjection, type WorkProjection } from "@/lib/events";
import type {
  AgentCommand,
  AgentProfile,
  AgentSession,
  ApprovalRecord,
  ConfigOption,
  FlowRecord,
  MessageAttachmentInput,
  SessionEvent,
  WorkspaceListing,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { applyComposerSuggestion, attachmentPreviewUrl, composerTrigger, filterCommands, isModelOption, isPermissionOption, isSpeedOption, isThoughtLevelOption, mergeConversationEvents, orderSessions, restoreSessionSelection, serializeConfigOverride, speedValueLabel, workspacePaths } from "@/lib/workbench-logic";

type Theme = "paper" | "carbon";
type PanelArea = "agents" | "flows";
type MenuView = "actions" | "rename" | "delete";

const themes = {
  paper: {
    canvas: "bg-[#F6F7F4] text-[#191C16]",
    sidebar: "bg-[#FBFCFA]",
    surface: "bg-white",
    surfaceSoft: "bg-[#EEF1EB]",
    surfaceTint: "bg-[#F2F4EF]",
    ink: "text-[#191C16]",
    inkSoft: "text-[#373C32]",
    muted: "text-[#73796C]",
    faint: "text-[#9CA296]",
    line: "border-[#E0E4DC]",
    lineStrong: "border-[#CDD3C8]",
    accent: "bg-[#CCFF00]",
    accentText: "text-[#171A11]",
    accentSoft: "bg-[#E9F6AD]",
    success: "text-[#3B8659]",
    warning: "text-[#C27B18]",
    danger: "text-[#D25D3D]",
    dangerSoft: "bg-[#FCEBE6]",
    healthyDot: "bg-[#3B8659]",
    offlineDot: "bg-[#9CA296]",
    controlAccent: "text-[#3B8659]",
    controlHover: "hover:bg-[#E0E4DC]",
    placeholder: "placeholder:text-[#9CA296]",
    focus: "focus:border-[#73796C] focus-visible:ring-[#CDD3C8]",
    shadow: "shadow-[0_20px_48px_rgba(25,28,22,0.08)]",
    shadowSmall: "shadow-[0_4px_16px_rgba(25,28,22,0.07)]",
    menuItemFocus: "data-[highlighted]:bg-[#EEF1EB]",
  },
  carbon: {
    canvas: "bg-[#121411] text-[#F1F2EA]",
    sidebar: "bg-[#181A17]",
    surface: "bg-[#1C1F1B]",
    surfaceSoft: "bg-[#282C25]",
    surfaceTint: "bg-[#20231E]",
    ink: "text-[#F1F2EA]",
    inkSoft: "text-[#D2D6C9]",
    muted: "text-[#9DA496]",
    faint: "text-[#6E7669]",
    line: "border-[#30352D]",
    lineStrong: "border-[#444B40]",
    accent: "bg-[#FF683D]",
    accentText: "text-[#211610]",
    accentSoft: "bg-[#4B281F]",
    success: "text-[#74BF8F]",
    warning: "text-[#E7AA4E]",
    danger: "text-[#FF8063]",
    dangerSoft: "bg-[#41231D]",
    healthyDot: "bg-[#74BF8F]",
    offlineDot: "bg-[#6E7669]",
    controlAccent: "text-[#FF683D]",
    controlHover: "hover:bg-[#30352D]",
    placeholder: "placeholder:text-[#6E7669]",
    focus: "focus:border-[#9DA496] focus-visible:ring-[#444B40]",
    shadow: "shadow-[0_20px_56px_rgba(0,0,0,0.28)]",
    shadowSmall: "shadow-[0_5px_18px_rgba(0,0,0,0.22)]",
    menuItemFocus: "data-[highlighted]:bg-[#282C25]",
  },
} as const;

const DEFAULT_SELECT_VALUE = "__default__";

const statusLabel: Record<string, string> = {
  healthy: "Ready",
  unavailable: "Unavailable",
  needs_setup: "Needs setup",
  active: "Running",
  idle: "Ready",
  closed: "Closed",
};

export function Workbench() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [area, setArea] = useState<PanelArea>("agents");
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [approvals, setApprovals] = useState<ApprovalRecord[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [configOverrides, setConfigOverrides] = useState<Record<string, string | boolean>>({});
  const [permissionMode, setPermissionMode] = useState("");
  const [flowId, setFlowId] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachmentInput[]>([]);
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const pendingEvents = useRef<Record<string, SessionEvent[]>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<MenuView>("actions");
  const [renameDraft, setRenameDraft] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [workspaceListing, setWorkspaceListing] = useState<WorkspaceListing | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const conversationViewport = useRef<HTMLElement | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const selectedAgentRef = useRef<string | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const t = themes[theme];

  const selectedSession = sessions.find((session) => session.session_id === selectedSessionId) ?? null;
  const selectedAgent = agents.find((agent) => agent.agent_id === (selectedSession?.agent_id ?? selectedAgentId)) ?? null;
  const agentSessions = useMemo(
    () => orderSessions(sessions.filter((session) => session.agent_id === selectedAgentId))
      .filter((session) => showArchived ? Boolean(session.archived_at) : !session.archived_at)
      .filter((session) => (session.title || "未命名 Session").toLowerCase().includes(query.toLowerCase())),
    [query, selectedAgentId, sessions, showArchived],
  );
  const activeSessionCount = sessions.filter((session) => session.agent_id === selectedAgentId && !session.archived_at).length;
  const archivedSessionCount = sessions.filter((session) => session.agent_id === selectedAgentId && session.archived_at).length;
  const projection = useMemo(() => reduceConversationEvents(events), [events]);
  const modelOption = useMemo(() => configOptions.find(isModelOption), [configOptions]);
  const thoughtLevelOption = useMemo(() => configOptions.find(isThoughtLevelOption), [configOptions]);
  const speedOption = useMemo(() => configOptions.find(isSpeedOption), [configOptions]);
  const permissionOption = useMemo(() => configOptions.find(isPermissionOption), [configOptions]);

  const notify = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? "" : current), 1800);
  }, []);

  const reload = useCallback(async (importProvider = false, silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const [nextAgents, nextSessions, nextFlows] = await Promise.all([
        api.agents(),
        api.sessions(importProvider, true),
        api.flows(),
      ]);
      setAgents(nextAgents);
      setSessions(nextSessions);
      setFlows(nextFlows.filter((flow) => flow.status !== "deprecated"));
      const nextAgentId = selectedAgentRef.current && nextAgents.some((agent) => agent.agent_id === selectedAgentRef.current)
        ? selectedAgentRef.current
        : nextAgents[0]?.agent_id ?? null;
      setSelectedAgentId(nextAgentId);
      setSelectedSessionId(nextAgentId
        ? restoreSessionSelection(
          nextSessions,
          selectedSessionRef.current,
          nextAgentId,
          window.localStorage.getItem(`codebridge:last-session:${nextAgentId}`),
        )
        : null);
    } catch (caught) {
      if (!silent) setError(messageOf(caught));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(false).then(() => void reload(true, true)); }, [reload]);

  useEffect(() => { selectedAgentRef.current = selectedAgentId; }, [selectedAgentId]);
  useEffect(() => { selectedSessionRef.current = selectedSessionId; }, [selectedSessionId]);

  useEffect(() => {
    window.localStorage.setItem("codebridge:web-theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!selectedSessionId) {
      streamAbort.current?.abort();
      setEvents([]);
      setCommands([]);
      setConfigOptions([]);
      setApprovals([]);
      setModel("");
      setEffort("");
      setConfigOverrides({});
      setPermissionMode("");
      setFlowId("");
      setLoadingSession(false);
      setWorkspaceListing(null);
      return;
    }

    const sessionId = selectedSessionId;
    let active = true;
    streamAbort.current?.abort();
    const controller = new AbortController();
    streamAbort.current = controller;
    setLoadingSession(true);
    setEvents(pendingEvents.current[sessionId] ?? []);
    setError(null);
    setMenuOpen(false);
    setMenuView("actions");
    setCommandOpen(false);
    setContextOpen(false);
    setWorkspaceListing(null);

    void (async () => {
      try {
        const { session, events: history, commands: nextCommands, options, runs } = await api.openSession(sessionId);
      if (!active) return;
        setSessions((current) => current.map((value) => value.session_id === session.session_id ? session : value));
        setEvents((current) => mergeConversationEvents(pendingEvents.current[sessionId] ?? current, history));
        setCommands(nextCommands);
        setConfigOptions(options);
        setModel(session.model ?? "");
        setEffort(session.effort ?? "");
        setConfigOverrides(session.config_overrides ?? {});
        setPermissionMode(session.permission_mode ?? "");
        setFlowId(session.flow_id ?? "");
        const latestRun = runs.at(-1);
        setApprovals(latestRun ? await api.approvals(latestRun.run_id).catch(() => []) : []);
        setLoadingSession(false);
        const after = history.reduce((max, event) => Math.max(max, event.sequence), 0);
        await streamSessionEvents(sessionId, after, controller.signal, (event) => {
          if (!active) return;
          setEvents((current) => current.some((item) => item.event_id === event.event_id) ? current : [...current, event]);
        });
      } catch (caught) {
        if (active && !controller.signal.aborted) setError(messageOf(caught));
        if (active) setLoadingSession(false);
      }
    })();

    return () => {
      active = false;
      controller.abort();
    };
  }, [selectedSessionId]);

  useEffect(() => {
    if (loadingSession || !selectedSessionId || !conversationViewport.current) return;
    const frame = window.requestAnimationFrame(() => {
      if (conversationViewport.current) conversationViewport.current.scrollTop = conversationViewport.current.scrollHeight;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events, selectedSessionId, loadingSession, sending]);

  function selectAgent(agentId: string) {
    selectedAgentRef.current = agentId;
    setSelectedAgentId(agentId);
    setArea("agents");
    setQuery("");
    setShowArchived(false);
    const remembered = window.localStorage.getItem(`codebridge:last-session:${agentId}`);
    const nextSessionId = restoreSessionSelection(sessions, selectedSessionRef.current, agentId, remembered);
    selectedSessionRef.current = nextSessionId;
    setSelectedSessionId(nextSessionId);
  }

  function selectSession(session: AgentSession) {
    selectedAgentRef.current = session.agent_id;
    selectedSessionRef.current = session.session_id;
    setSelectedAgentId(session.agent_id);
    setSelectedSessionId(session.session_id);
    window.localStorage.setItem(`codebridge:last-session:${session.agent_id}`, session.session_id);
  }

  async function createSession(agentId: string): Promise<AgentSession | undefined> {
    setError(null);
    try {
      const session = await api.createSession(agentId);
      setSessions((current) => [session, ...current]);
      selectSession(session);
      return session;
    } catch (caught) {
      setError(messageOf(caught));
      return undefined;
    }
  }

  async function submit() {
    const message = draft.trim();
    if (!message || sending || !selectedAgent || selectedAgent.status !== "healthy") return;
    setSending(true);
    setError(null);
    let sessionId = selectedSessionId;
    if (!sessionId) sessionId = (await createSession(selectedAgent.agent_id))?.session_id ?? null;
    if (!sessionId) {
      setSending(false);
      return;
    }
    const pendingAttachments = attachments;
    setDraft("");
    setAttachments([]);
    try {
      const receipt = await api.sendMessage(sessionId, message, flowId || null, model || null, pendingAttachments, permissionMode || null, effort || null);
      const messageEvent: SessionEvent = {
        event_id: receipt.event_id,
        sequence: receipt.sequence,
        run_id: null,
        type: "MESSAGE_RECEIVED",
        occurred_at: new Date().toISOString(),
        payload: { message, attachment_ids: [] },
      };
      pendingEvents.current[sessionId] = [...(pendingEvents.current[sessionId] ?? []), messageEvent];
      setEvents((current) => mergeConversationEvents(current, [messageEvent]));
      await api.startRun(sessionId, flowId || null, model || null, permissionMode || null, effort || null);
      setSessions((current) => current.map((session) => session.session_id === sessionId
        ? { ...session, status: "active", title: session.title ?? message.slice(0, 60), updated_at: new Date().toISOString() }
        : session));
    } catch (caught) {
      setDraft(message);
      setAttachments(pendingAttachments);
      setError(messageOf(caught));
    } finally {
      setSending(false);
    }
  }

  async function applySessionUpdate(sessionId: string, update: Record<string, unknown>) {
    setError(null);
    try {
      const updated = await api.updateSession(sessionId, update);
      setSessions((current) => current.map((session) => session.session_id === updated.session_id ? updated : session));
      if (selectedSessionId === sessionId) {
        setModel(updated.model ?? "");
        setEffort(updated.effort ?? "");
        setConfigOverrides(updated.config_overrides ?? {});
        setPermissionMode(updated.permission_mode ?? "");
      }
      if (updated.archived_at && selectedSessionId === sessionId) {
        window.localStorage.removeItem(`codebridge:last-session:${updated.agent_id}`);
        selectedSessionRef.current = null;
        setSelectedSessionId(null);
        setShowArchived(false);
      }
      setMenuOpen(false);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function updateSession(update: Record<string, unknown>) {
    if (selectedSessionId) await applySessionUpdate(selectedSessionId, update);
  }

  function setSessionPermissionMode(value: string) {
    setPermissionMode(value);
    void updateSession({ permission_mode: value || null });
  }

  function setSessionEffort(value: string) {
    setEffort(value);
    void updateSession({ effort: value || null });
  }

  function setSessionConfigOverride(option: ConfigOption, value: string) {
    const next = { ...configOverrides };
    if (value) next[option.id] = serializeConfigOverride(option, value);
    else delete next[option.id];
    setConfigOverrides(next);
    void updateSession({ config_overrides: next });
  }

  async function deleteSessionById(sessionId: string) {
    try {
      await api.deleteSession(sessionId);
      setSessions((current) => current.filter((session) => session.session_id !== sessionId));
      if (selectedSessionId === sessionId) {
        if (selectedSession) window.localStorage.removeItem(`codebridge:last-session:${selectedSession.agent_id}`);
        selectedSessionRef.current = null;
        setSelectedSessionId(null);
        setMenuOpen(false);
      }
      notify("Session 已删除");
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function deleteSelected() {
    if (selectedSessionId) await deleteSessionById(selectedSessionId);
  }

  async function pickDirectory() {
    if (!selectedSessionId || pickingDirectory) return;
    setPickingDirectory(true);
    setError(null);
    try {
      const result = await api.pickDirectory(selectedSessionId);
      if (!("cancelled" in result)) {
        setSessions((current) => current.map((session) => session.session_id === result.session_id ? result : session));
        notify("Workspace 已添加");
      }
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setPickingDirectory(false);
    }
  }

  async function resolveApproval(item: ApprovalProjection, approve: boolean) {
    if (!item.runId) return;
    const approval = approvals.find((record) => record.id === item.requestId)
      ?? approvals.find((record) => record.run_id === item.runId && record.status === "requested");
    if (!approval) {
      setError("审批记录尚未同步，请稍后重试");
      return;
    }
    try {
      if (approve) await api.approve(item.runId, approval.id);
      else await api.reject(item.runId, approval.id);
      setApprovals((current) => current.map((record) => record.id === approval.id
        ? { ...record, status: approve ? "granted" : "revoked" }
        : record));
      notify(approve ? "已授权本次操作" : "已拒绝并暂停 Run");
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function addFiles(files: FileList | File[]) {
    try {
      const next = await Promise.all(Array.from(files).map(readAttachment));
      setAttachments((current) => [...current, ...next]);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function browseWorkspace(relativePath = "", root?: string) {
    if (!selectedSessionId) return;
    setContextOpen(true);
    setWorkspaceLoading(true);
    try {
      setWorkspaceListing(await api.workspaceEntries(selectedSessionId, root, relativePath));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setWorkspaceLoading(false);
    }
  }

  function toggleContext(open: boolean) {
    setContextOpen(open);
    if (open && !workspaceListing && selectedSessionId) void browseWorkspace();
  }

  return (
    <div className={cn("grid h-[100dvh] min-h-[100dvh] min-w-[1040px] grid-cols-[60px_286px_minmax(0,1fr)] overflow-hidden font-sans text-[13px] tracking-[-0.01em]", t.canvas)}>
      <AgentRail
        agents={agents}
        area={area}
        selectedAgentId={selectedAgentId}
        theme={theme}
        onAgent={selectAgent}
        onArea={setArea}
        onTheme={() => setTheme((current) => current === "paper" ? "carbon" : "paper")}
      />

      <SessionPanel
        agent={selectedAgent}
        activeSessionCount={activeSessionCount}
        area={area}
        archivedSessionCount={archivedSessionCount}
        flows={flows}
        flowId={flowId}
        loading={loading}
        query={query}
        sessions={agentSessions}
        selectedSessionId={selectedSessionId}
        theme={theme}
        onCreate={() => selectedAgent && void createSession(selectedAgent.agent_id)}
        onFlow={(id) => { setFlowId(id); setArea("agents"); }}
        onQuery={setQuery}
        onRefresh={() => void reload(true)}
        onSession={selectSession}
        onUpdateSession={(session, update) => applySessionUpdate(session.session_id, update)}
        onDeleteSession={(session) => deleteSessionById(session.session_id)}
        onToggleArchived={() => setShowArchived((current) => !current)}
        showArchived={showArchived}
      />

      <main className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", t.canvas)}>
        <SessionHeader
          agent={selectedAgent}
          session={selectedSession}
          theme={theme}
          menuOpen={menuOpen}
          menuView={menuView}
          renameDraft={renameDraft}
          onDelete={() => void deleteSelected()}
          onMenu={() => { setMenuOpen((current) => !current); setMenuView("actions"); }}
          onMenuView={setMenuView}
          onRenameDraft={setRenameDraft}
          onUpdate={(update) => void updateSession(update)}
        />

        {error && <div className={cn("mx-8 mt-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs", t.dangerSoft, t.danger, t.lineStrong)} role="alert"><X className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button aria-label="关闭错误" onClick={() => setError(null)} type="button"><X className="size-3.5" /></button></div>}

        {!selectedSession ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-20">
            <div className="w-full max-w-[760px]">
              <div className="mb-7 text-center">
                <div className={cn("mx-auto mb-4 grid size-10 place-items-center rounded-md border", t.accent, t.accentText, t.lineStrong)}>{selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id} className="size-[18px]" /> : <PixelMark className="size-5" />}</div>
                <h1 className={cn("font-brand text-2xl font-normal leading-none tracking-normal", t.ink)}>{selectedAgent ? selectedAgent.display_name : "CodeBridge"}</h1>
                <p className={cn("mt-2 text-xs", t.muted)}>{selectedAgent ? "创建 Session，或直接输入目标" : "选择一个可用的 Agent"}</p>
              </div>
              <Composer
                attachments={attachments}
                commands={commands}
                contextOpen={contextOpen}
                workspaceListing={null}
                workspaceLoading={false}
                disabled={!selectedAgent || selectedAgent.status !== "healthy"}
                draft={draft}
                flowId={flowId}
                flows={flows}
                model={model}
                modelOption={modelOption}
                effort={effort}
                thoughtLevelOption={thoughtLevelOption}
                configOverrides={configOverrides}
                speedOption={speedOption}
                permissionMode={permissionMode}
                permissionOption={permissionOption}
                sending={sending}
                session={null}
                theme={theme}
                commandOpen={commandOpen}
                onAddFiles={addFiles}
                onCommandOpen={setCommandOpen}
                onContext={() => undefined}
                onContextNavigate={() => undefined}
                onContextOpen={toggleContext}
                onDraft={setDraft}
                onFiles={() => fileInput.current?.click()}
                onFlow={setFlowId}
                onModel={(value) => { setModel(value); void updateSession({ model: value || null }); }}
                onEffort={setSessionEffort}
                onConfigOverride={setSessionConfigOverride}
                onPermissionMode={setSessionPermissionMode}
                onPickDirectory={() => notify("Session 创建后可添加 Workspace")}
                onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, valueIndex) => valueIndex !== index))}
                onSubmit={() => void submit()}
              />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <section aria-label="Session conversation" className="min-h-0 flex-1 overflow-y-auto px-8 pt-7" ref={conversationViewport}>
              <div className="mx-auto w-full max-w-[880px] pb-7">
                {loadingSession ? <LoadingConversation theme={theme} /> : projection.length ? (
                  <div className="grid gap-6">
                    {projection.map((item, index) => (
                      <ProjectionItem
                        approvals={approvals}
                        cwd={selectedSession.cwd}
                        item={item}
                        key={projectionKey(item, index)}
                        onApproval={resolveApproval}
                        theme={theme}
                      />
                    ))}
                  </div>
                ) : <div aria-label="Empty Session" className="flex min-h-[42vh] flex-col items-center justify-center text-center">
                  <div className={cn("mb-4 grid size-10 place-items-center rounded-md border", t.accent, t.accentText, t.lineStrong)}>{selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id} className="size-[18px]" /> : <PixelMark className="size-5" />}</div>
                  <h2 className={cn("font-brand text-xl font-normal tracking-[-0.02em]", t.ink)}>{selectedSession.title || (selectedAgent ? `${selectedAgent.display_name} Session` : "Session")}</h2>
                  <p className={cn("mt-2 text-xs", t.muted)}>输入目标开始当前 Session</p>
                </div>}
              </div>
            </section>
            <footer className="px-8 pb-5 pt-3">
              <div className="mx-auto w-full max-w-[880px]">
                <Composer
                  attachments={attachments}
                  commands={commands}
                  contextOpen={contextOpen}
                  workspaceListing={workspaceListing}
                  workspaceLoading={workspaceLoading}
                  disabled={false}
                  draft={draft}
                  flowId={flowId}
                  flows={flows}
                  model={model}
                  modelOption={modelOption}
                  effort={effort}
                  thoughtLevelOption={thoughtLevelOption}
                  configOverrides={configOverrides}
                  speedOption={speedOption}
                  permissionMode={permissionMode}
                  permissionOption={permissionOption}
                  sending={sending}
                  session={selectedSession}
                  theme={theme}
                  commandOpen={commandOpen}
                  onAddFiles={addFiles}
                  onCommandOpen={setCommandOpen}
                  onContext={(path) => setDraft((current) => applyComposerSuggestion(current, `@${path} `))}
                  onContextNavigate={(path, root) => void browseWorkspace(path, root)}
                  onContextOpen={toggleContext}
                  onDraft={setDraft}
                  onFiles={() => fileInput.current?.click()}
                  onFlow={setFlowId}
                  onModel={(value) => { setModel(value); void updateSession({ model: value || null }); }}
                  onEffort={setSessionEffort}
                  onConfigOverride={setSessionConfigOverride}
                  onPermissionMode={setSessionPermissionMode}
                  onPickDirectory={() => void pickDirectory()}
                  onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, valueIndex) => valueIndex !== index))}
                  onSubmit={() => void submit()}
                />
              </div>
            </footer>
          </div>
        )}
      </main>

      <input className="hidden" multiple onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} ref={fileInput} type="file" />
      {notice && <div className={cn("fixed bottom-6 right-6 z-50 rounded-md border px-3 py-2 text-xs", t.surface, t.ink, t.lineStrong, t.shadow)} role="status">{notice}</div>}
    </div>
  );
}

function AgentRail({ agents, area, selectedAgentId, theme, onAgent, onArea, onTheme }: {
  agents: AgentProfile[];
  area: PanelArea;
  selectedAgentId: string | null;
  theme: Theme;
  onAgent: (id: string) => void;
  onArea: (area: PanelArea) => void;
  onTheme: () => void;
}) {
  const t = themes[theme];
  return <aside className={cn("flex min-h-0 flex-col items-center gap-3 border-r px-2.5 py-3", t.sidebar, t.line)}>
    <div className={cn("mb-3 grid size-9 place-items-center rounded-md border", t.accent, t.accentText, t.lineStrong)} title="AGNET · CodeBridge"><PixelMark className="size-4" /></div>
    <div className="grid w-full gap-2">
      {agents.map((agent) => {
        const selected = area === "agents" && selectedAgentId === agent.agent_id;
        return <button aria-label={agent.display_name} aria-pressed={selected} className={cn("group relative grid size-[42px] place-items-center rounded-md border border-transparent transition-all duration-150 hover:-translate-y-px hover:opacity-80", t.muted, selected && cn(t.surface, t.ink, t.lineStrong, t.shadowSmall))} key={agent.agent_id} onClick={() => onAgent(agent.agent_id)} title={`${agent.display_name} · ${statusLabel[agent.status] ?? agent.status}`} type="button">
          <BrandAgentIcon agentId={agent.agent_id} className="size-[18px]" />
          <span className={cn("absolute bottom-1.5 right-1.5 size-1.5 rounded-full border-2", theme === "paper" ? "border-[#FBFCFA]" : "border-[#181A17]", agent.status === "healthy" ? t.healthyDot : t.offlineDot)} />
        </button>;
      })}
    </div>
    <div className={cn("my-2 h-px w-8 border-t", t.line)} />
    <button aria-label="Flows" aria-pressed={area === "flows"} className={cn("grid size-9 place-items-center rounded-md transition-colors hover:opacity-80", t.muted, area === "flows" && cn(t.surface, t.ink, t.shadowSmall))} onClick={() => onArea("flows")} title="Flows" type="button"><Workflow className="size-3.5" /></button>
    <div className="flex-1" />
    <button aria-label="切换主题" className={cn("grid size-9 place-items-center rounded-md transition-all hover:-translate-y-px hover:opacity-80", t.muted)} onClick={onTheme} title={theme === "paper" ? "Carbon Vermilion" : "Paper Lime"} type="button"><Sun className="size-3.5" /></button>
  </aside>;
}

function SessionRow({ session, selected, theme, onSession, onUpdateSession, onDeleteSession }: {
  session: AgentSession;
  selected: boolean;
  theme: Theme;
  onSession: (session: AgentSession) => void;
  onUpdateSession: (session: AgentSession, update: Record<string, unknown>) => Promise<void>;
  onDeleteSession: (session: AgentSession) => Promise<void>;
}) {
  const t = themes[theme];
  const title = session.title || "未命名 Session";
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<MenuView>("actions");
  const [renameDraft, setRenameDraft] = useState(title);

  function closeMenu() {
    setMenuOpen(false);
    setMenuView("actions");
  }

  return <div className="group relative">
    <button className={cn("relative grid w-full gap-1 rounded-md border border-transparent px-3 py-2.5 pr-10 text-left transition-colors hover:opacity-80", t.ink, selected && cn(t.surface, t.line, t.shadowSmall))} onClick={() => { closeMenu(); onSession(session); }} title={title} type="button">
      <span className="truncate text-xs font-medium">{title}</span>
      <span className={cn("flex items-center gap-1.5 text-[10px]", t.muted)}>{session.pinned_at && <Pin className={cn("size-3", t.warning)} />}<span>{statusLabel[session.status] ?? session.status}</span><span>·</span><time className="font-mono">{relativeTime(session.updated_at)}</time></span>
      {selected && <span className={cn("absolute right-2.5 top-3.5 size-1.5 rounded-full", t.accent)} />}
    </button>
    <Button aria-label={`管理 ${title}`} className={cn("absolute right-1.5 top-2.5 size-7 px-0", t.muted, menuOpen ? cn(t.surfaceSoft, t.ink) : "")} onClick={(event) => { event.stopPropagation(); setMenuOpen((current) => !current); setMenuView("actions"); }} size="icon" variant="ghost"><MoreHorizontal className="size-3.5" /></Button>
    {menuOpen && <div className={cn("absolute right-1.5 top-10 z-40 w-48 rounded-lg border p-1", t.surface, t.lineStrong, t.shadow)} onClick={(event) => event.stopPropagation()}>
      {menuView === "rename" ? <div className="space-y-2 p-2"><label className={cn("text-xs", t.muted)} htmlFor={`session-name-${session.session_id}`}>Session 名称</label><input autoFocus className={cn("h-8 w-full rounded-md border bg-transparent px-2 text-xs outline-none", t.ink, t.lineStrong, t.focus)} id={`session-name-${session.session_id}`} onChange={(event) => setRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameDraft.trim()) { void onUpdateSession(session, { title: renameDraft.trim() }); closeMenu(); } if (event.key === "Escape") closeMenu(); }} value={renameDraft} /><div className="flex justify-end gap-1"><MenuButton theme={theme} onClick={closeMenu}>取消</MenuButton><MenuButton disabled={!renameDraft.trim()} theme={theme} onClick={() => { void onUpdateSession(session, { title: renameDraft.trim() }); closeMenu(); }}>保存</MenuButton></div></div>
        : menuView === "delete" ? <div className="space-y-3 p-2"><p className={cn("text-xs leading-5", t.muted)}>删除后无法恢复这个 Session。</p><div className="flex justify-end gap-1"><MenuButton theme={theme} onClick={() => setMenuView("actions")}>取消</MenuButton><MenuButton danger theme={theme} onClick={() => { void onDeleteSession(session); closeMenu(); }}>删除</MenuButton></div></div>
          : <><MenuButton theme={theme} onClick={() => { void onUpdateSession(session, { pinned: !session.pinned_at }); closeMenu(); }}><Pin className="size-3.5" />{session.pinned_at ? "取消 PIN" : "PIN Session"}</MenuButton><MenuButton theme={theme} onClick={() => { setRenameDraft(title); setMenuView("rename"); }}><Pencil className="size-3.5" />重命名</MenuButton><MenuButton theme={theme} onClick={() => { void onUpdateSession(session, { archived: !session.archived_at }); closeMenu(); }}><Archive className="size-3.5" />{session.archived_at ? "恢复 Session" : "归档"}</MenuButton><MenuButton danger theme={theme} onClick={() => setMenuView("delete")}><Trash2 className="size-3.5" />删除</MenuButton></>}
    </div>}
  </div>;
}

function SessionPanel({ agent, activeSessionCount, area, archivedSessionCount, flows, flowId, loading, query, sessions, selectedSessionId, showArchived, theme, onCreate, onFlow, onQuery, onRefresh, onSession, onUpdateSession, onDeleteSession, onToggleArchived }: {
  agent: AgentProfile | null;
  activeSessionCount: number;
  area: PanelArea;
  archivedSessionCount: number;
  flows: FlowRecord[];
  flowId: string;
  loading: boolean;
  query: string;
  sessions: AgentSession[];
  selectedSessionId: string | null;
  showArchived: boolean;
  theme: Theme;
  onCreate: () => void;
  onFlow: (id: string) => void;
  onQuery: (value: string) => void;
  onRefresh: () => void;
  onSession: (session: AgentSession) => void;
  onUpdateSession: (session: AgentSession, update: Record<string, unknown>) => Promise<void>;
  onDeleteSession: (session: AgentSession) => Promise<void>;
  onToggleArchived: () => void;
}) {
  const t = themes[theme];
  return <aside className={cn("flex min-h-0 min-w-0 flex-col border-r", t.sidebar, t.line)}>
    <header className="flex items-start justify-between gap-3 px-5 pb-4 pt-6">
      <div className="min-w-0"><p className={cn("mb-1 font-brand text-[10px] font-normal uppercase tracking-[0.1em]", t.muted)}>{area === "agents" ? "Agent profile" : "Catalog"}</p><h1 className={cn("truncate font-brand text-lg font-normal tracking-[-0.035em]", t.ink)}>{area === "agents" ? agent?.display_name ?? "Agents" : "Flows"}</h1><p className={cn("mt-1.5 flex items-center gap-1.5 text-[11px]", t.muted)}><Circle className={cn("size-1.5 fill-current", area === "agents" && agent?.status === "healthy" ? t.success : t.faint)} />{area === "agents" ? `${statusLabel[agent?.status ?? "unavailable"] ?? agent?.status ?? "Unavailable"} · ${sessions.length} sessions` : `${flows.length} published definitions`}</p></div>
      <div className="flex gap-1">
        <Button aria-label="刷新" className={cn("size-8 px-0 hover:opacity-80", t.muted)} onClick={onRefresh} size="icon" variant="ghost"><RefreshCw className={cn("size-3.5", loading && "animate-spin")} /></Button>
        {area === "agents" && <Button aria-label="新建 Session" className={cn("size-8 border px-0 hover:-translate-y-px hover:opacity-80", t.surface, t.ink, t.lineStrong)} disabled={!agent || agent.status !== "healthy"} onClick={onCreate} size="icon" variant="outline"><Plus className="size-4" /></Button>}
      </div>
    </header>
    {area === "agents" ? <>
      <div className="px-4 pb-3"><label className={cn("flex h-[34px] items-center gap-2 rounded-md border px-2.5", t.surface, t.line)}><Search className={cn("size-3.5", t.muted)} /><input aria-label="搜索 Session" className={cn("min-w-0 flex-1 bg-transparent text-xs outline-none", t.ink, t.placeholder)} onChange={(event) => onQuery(event.target.value)} placeholder="搜索 Session" value={query} /></label></div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4">
        <div className={cn("px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.1em]", t.faint)}><span>{showArchived ? "Archived" : "Sessions"}</span><span className="float-right font-mono">{showArchived ? archivedSessionCount : activeSessionCount}</span></div>
        {sessions.map((session) => <SessionRow key={session.session_id} onDeleteSession={onDeleteSession} onSession={onSession} onUpdateSession={onUpdateSession} selected={selectedSessionId === session.session_id} session={session} theme={theme} />)}
        {!loading && !sessions.length && <div className={cn("px-3 py-8 text-center text-xs", t.muted)}>{showArchived ? "暂无已归档 Session" : "当前 Agent 暂无 Session"}</div>}
      </div>
      <footer className={cn("border-t px-3 py-2", t.line)}><button className={cn("flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[11px] transition-opacity hover:opacity-80", t.muted)} onClick={onToggleArchived} type="button"><Archive className="size-3.5" /><span className="flex-1">{showArchived ? "返回 Sessions" : "已归档"}</span><span className="font-mono text-[10px]">{showArchived ? activeSessionCount : archivedSessionCount}</span></button></footer>
    </> : <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-4"><div className={cn("px-2.5 py-2 text-[10px] font-semibold uppercase tracking-[0.1em]", t.faint)}>Published</div>{flows.map((flow) => <button className={cn("flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2.5 text-left text-xs transition-colors hover:opacity-80", t.ink, flowId === flow.flow_id && cn(t.surface, t.line))} key={flow.flow_id} onClick={() => onFlow(flow.flow_id)} type="button"><Workflow className={cn("size-3.5", t.muted)} /><span className="min-w-0 flex-1 truncate">{flow.name || flow.flow_id}</span><span className={cn("font-mono text-[10px]", t.faint)}>{flow.kind}</span></button>)}{!flows.length && <div className={cn("px-3 py-8 text-center text-xs", t.muted)}>暂无已发布 Flow</div>}</div>}
  </aside>;
}

function SessionHeader({ agent, session, theme, menuOpen, menuView, renameDraft, onDelete, onMenu, onMenuView, onRenameDraft, onUpdate }: {
  agent: AgentProfile | null;
  session: AgentSession | null;
  theme: Theme;
  menuOpen: boolean;
  menuView: MenuView;
  renameDraft: string;
  onDelete: () => void;
  onMenu: () => void;
  onMenuView: (view: MenuView) => void;
  onRenameDraft: (value: string) => void;
  onUpdate: (update: Record<string, unknown>) => void;
}) {
  const t = themes[theme];
  return <header className={cn("flex min-h-[72px] shrink-0 items-center justify-between gap-5 border-b px-8 py-4", t.line)}>
    <div className="flex min-w-0 items-center gap-3"><span className={cn("grid size-7 shrink-0 place-items-center rounded-md border", t.accent, t.accentText, t.lineStrong)}>{agent ? <BrandAgentIcon agentId={agent.agent_id} className="size-3.5" /> : <PixelMark className="size-3.5" />}</span><div className="min-w-0"><h2 className={cn("truncate font-brand text-sm font-normal tracking-[-0.02em]", t.ink)}>{session?.title || (agent ? `${agent.display_name} Session` : "CodeBridge")}</h2><p className={cn("mt-0.5 truncate text-[11px]", t.muted)}>{session?.cwd || agent?.display_name || "Agent Workbench"}</p></div></div>
    {session && <div className="relative flex items-center gap-2">
      <span className={cn("hidden items-center gap-1.5 text-[11px] sm:flex", t.muted)}><span className={cn("size-1.5 rounded-full", session.status === "active" || session.status === "idle" ? t.healthyDot : t.offlineDot)} />{statusLabel[session.status] ?? session.status}</span>
      <Button aria-label="Session 操作" className={cn("size-8 px-0", t.muted)} onClick={onMenu} size="icon" variant="ghost"><MoreHorizontal className="size-4" /></Button>
      {menuOpen && <div className={cn("absolute right-0 top-11 z-30 w-56 rounded-lg border p-1", t.surface, t.lineStrong, t.shadow)}>{menuView === "rename" ? <div className="space-y-2 p-2"><label className={cn("text-xs", t.muted)} htmlFor="session-name">Session 名称</label><input autoFocus className={cn("h-9 w-full rounded-md border bg-transparent px-2.5 text-sm outline-none", t.ink, t.lineStrong, t.focus)} id="session-name" onChange={(event) => onRenameDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && renameDraft.trim()) onUpdate({ title: renameDraft.trim() }); if (event.key === "Escape") onMenuView("actions"); }} value={renameDraft} /><div className="flex justify-end gap-1"><MenuButton theme={theme} onClick={() => onMenuView("actions")}>取消</MenuButton><MenuButton disabled={!renameDraft.trim()} theme={theme} onClick={() => onUpdate({ title: renameDraft.trim() })}>保存</MenuButton></div></div> : menuView === "delete" ? <div className="space-y-3 p-2"><p className={cn("text-xs leading-5", t.muted)}>删除后无法从 CodeBridge 恢复这个 Session。</p><div className="flex justify-end gap-1"><MenuButton theme={theme} onClick={() => onMenuView("actions")}>取消</MenuButton><MenuButton danger theme={theme} onClick={onDelete}>删除</MenuButton></div></div> : <>
        <MenuButton theme={theme} onClick={() => onUpdate({ pinned: !session.pinned_at })}><Pin className="size-3.5" />{session.pinned_at ? "取消 PIN" : "PIN Session"}</MenuButton>
        <MenuButton theme={theme} onClick={() => { onRenameDraft(session.title || ""); onMenuView("rename"); }}><Pencil className="size-3.5" />重命名</MenuButton>
        <MenuButton theme={theme} onClick={() => onUpdate({ archived: !session.archived_at })}><Archive className="size-3.5" />{session.archived_at ? "恢复 Session" : "归档"}</MenuButton>
        <MenuButton danger theme={theme} onClick={() => onMenuView("delete")}><Trash2 className="size-3.5" />删除</MenuButton>
      </>}</div>}
    </div>}
  </header>;
}

function Composer({ attachments, commands, contextOpen, workspaceListing, workspaceLoading, disabled, draft, flowId, flows, model, modelOption, effort, thoughtLevelOption, configOverrides, speedOption, permissionMode, permissionOption, sending, session, theme, commandOpen, onAddFiles, onCommandOpen, onContext, onContextNavigate, onContextOpen, onDraft, onFiles, onFlow, onModel, onEffort, onConfigOverride, onPermissionMode, onPickDirectory, onRemoveAttachment, onSubmit }: {
  attachments: MessageAttachmentInput[];
  commands: AgentCommand[];
  contextOpen: boolean;
  workspaceListing: WorkspaceListing | null;
  workspaceLoading: boolean;
  disabled: boolean;
  draft: string;
  flowId: string;
  flows: FlowRecord[];
  model: string;
  modelOption?: ConfigOption;
  effort: string;
  thoughtLevelOption?: ConfigOption;
  configOverrides: Record<string, string | boolean>;
  speedOption?: ConfigOption;
  permissionMode: string;
  permissionOption?: ConfigOption;
  sending: boolean;
  session: AgentSession | null;
  theme: Theme;
  commandOpen: boolean;
  onAddFiles: (files: FileList | File[]) => Promise<void>;
  onCommandOpen: (open: boolean) => void;
  onContext: (path: string) => void;
  onContextNavigate: (path: string, root?: string) => void;
  onContextOpen: (open: boolean) => void;
  onDraft: (value: string) => void;
  onFiles: () => void;
  onFlow: (value: string) => void;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onConfigOverride: (option: ConfigOption, value: string) => void;
  onPermissionMode: (value: string) => void;
  onPickDirectory: () => void;
  onRemoveAttachment: (index: number) => void;
  onSubmit: () => void;
}) {
  const t = themes[theme];
  const trigger = composerTrigger(draft);
  const visibleCommands = filterCommands(commands, trigger?.kind === "command" ? trigger.query : "");
  const contextQuery = trigger?.kind === "context" ? trigger.query.toLowerCase() : "";
  const visibleEntries = (workspaceListing?.entries ?? []).filter((entry) => !contextQuery || `${entry.name} ${entry.path}`.toLowerCase().includes(contextQuery));
  const hasWorkspace = workspacePaths(session).length > 0;
  return <div className={cn("relative rounded-xl border", t.surface, t.lineStrong, t.shadow)}>
    <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-3 pt-2.5">
      {modelOption ? <SessionConfigSelect label={defaultModelLabel(modelOption)} onValue={onModel} option={modelOption} theme={theme} value={model} /> : <ContextChip label="Agent default" theme={theme} />}
      {thoughtLevelOption && <ReasoningLevelControl onValue={onEffort} option={thoughtLevelOption} theme={theme} value={effort} />}
      {speedOption && <SpeedControl onValue={(value) => onConfigOverride(speedOption, value)} option={speedOption} overridden={Object.hasOwn(configOverrides, speedOption.id)} theme={theme} value={String(configOverrides[speedOption.id] ?? speedOption.currentValue ?? "false")} />}
      {permissionOption && <SessionConfigSelect label="Agent default" onValue={onPermissionMode} option={permissionOption} theme={theme} value={permissionMode} />}
      <button className={cn("inline-flex min-h-6 shrink-0 items-center gap-1.5 rounded border px-2 text-[10px] transition-opacity hover:opacity-80", t.surfaceSoft, t.muted, t.line)} onClick={onPickDirectory} type="button"><FolderOpen className="size-3" /><span className={cn("font-medium", t.inkSoft)}>{workspaceLabel(session)}</span></button>
      {flows.length > 0 && <div className={cn("inline-flex min-h-6 shrink-0 items-center rounded border pl-2 text-[10px]", t.surfaceSoft, t.muted, t.line)}><Workflow className="mr-1 size-3" /><Select onValueChange={(value) => onFlow(value === DEFAULT_SELECT_VALUE ? "" : value)} value={flowId || DEFAULT_SELECT_VALUE}>
        <SelectTrigger aria-label="Flow" className={cn("h-6 max-w-44 gap-1 border-0 bg-transparent px-1.5 py-0 text-[10px] shadow-none focus-visible:ring-0", t.inkSoft)}><SelectValue /></SelectTrigger>
        <SelectContent className={cn(t.surface, t.inkSoft, t.lineStrong, t.shadow)}>
          <SelectItem className={t.menuItemFocus} value={DEFAULT_SELECT_VALUE}>Flow · Automatic</SelectItem>
          {flows.map((flow) => <SelectItem className={t.menuItemFocus} key={flow.flow_id} value={flow.flow_id}>{flow.name || flow.flow_id}</SelectItem>)}
        </SelectContent>
      </Select></div>}
      <span className="flex-1" /><span className={cn("hidden shrink-0 text-[10px] sm:inline", t.faint)}>Enter to send</span>
    </div>
    {attachments.length > 0 && <div className="flex flex-wrap gap-2 px-3 pt-2">{attachments.map((attachment, index) => {
      const preview = attachmentPreviewUrl(attachment);
      return <div className={cn("group relative overflow-hidden rounded-md border", preview ? "size-16" : "inline-flex items-center gap-1.5 px-2 py-1 text-[10px]", t.surfaceTint, t.inkSoft, t.line)} key={`${attachment.name}-${index}`}>
        {preview ? <img alt={attachment.name} className="size-full object-cover" src={preview} /> : <><Paperclip className="size-3" /><span className="max-w-40 truncate">{attachment.name}</span></>}
        <button aria-label={`移除 ${attachment.name}`} className={cn(preview && "absolute right-1 top-1 grid size-5 place-items-center rounded-full", preview && t.surface)} onClick={() => onRemoveAttachment(index)} type="button"><X className="size-3" /></button>
      </div>;
    })}</div>}
    <Textarea aria-label="消息" className={cn("min-h-[76px] resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus:border-0 focus:ring-0", t.ink, t.placeholder)} disabled={disabled || sending} onChange={(event) => { const value = event.target.value; const nextTrigger = composerTrigger(value); onCommandOpen(nextTrigger?.kind === "command" && commands.length > 0); onContextOpen(nextTrigger?.kind === "context" && hasWorkspace); onDraft(value); }} onKeyDown={(event) => { if (event.nativeEvent.isComposing) return; if (event.key === "Escape") { onCommandOpen(false); onContextOpen(false); return; } if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); onSubmit(); } }} onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => { if (event.clipboardData.files.length) void onAddFiles(event.clipboardData.files); }} placeholder="输入目标，或继续当前工作…" value={draft} />
    <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
      <div className="flex items-center gap-1">
        <Button aria-label="添加文件" className={cn("size-7 px-0", t.muted)} onClick={onFiles} size="icon" title="添加文件或图片" variant="ghost"><Plus className="size-3.5" /></Button>
        {session && hasWorkspace && <Button aria-label="插入上下文" className={cn("size-7 px-0 text-xs", t.muted)} onClick={() => onContextOpen(!contextOpen)} size="icon" variant="ghost"><span>@</span></Button>}
        {contextOpen && hasWorkspace && <div className={cn("absolute bottom-[calc(100%+0.5rem)] left-12 z-30 w-[420px] overflow-hidden rounded-lg border", t.surface, t.lineStrong, t.shadow)}>
          <div className={cn("flex h-9 items-center gap-2 border-b px-2.5 text-[10px]", t.line, t.muted)}>
            {workspaceListing?.relativePath && <button aria-label="返回上级目录" className="grid size-6 place-items-center rounded-md hover:opacity-70" onClick={() => onContextNavigate(workspaceListing.relativePath!.split("/").slice(0, -1).join("/"), workspaceListing.root)} type="button"><ChevronDown className="size-3.5 rotate-90" /></button>}
            <FolderOpen className="size-3.5" /><span className="min-w-0 flex-1 truncate font-mono">{workspaceListing?.path ?? workspacePaths(session)[0]}</span>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {workspaceLoading ? <div className={cn("px-3 py-6 text-center text-xs", t.muted)}>正在读取 Workspace…</div> : visibleEntries.length ? visibleEntries.map((entry) => <button className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:opacity-80", t.ink)} key={entry.absolutePath} onClick={() => entry.kind === "directory" ? onContextNavigate(entry.path, workspaceListing?.root) : (onContext(entry.absolutePath), onContextOpen(false))} type="button">{entry.kind === "directory" ? <FolderOpen className={cn("size-3.5 shrink-0", t.muted)} /> : <FileText className={cn("size-3.5 shrink-0", t.muted)} />}<span className="min-w-0 flex-1 truncate">{entry.name}</span><span className={cn("max-w-48 truncate font-mono text-[10px]", t.faint)}>{entry.path}</span>{entry.kind === "directory" && <ChevronRight className={cn("size-3.5 shrink-0", t.faint)} />}</button>) : <div className={cn("px-3 py-6 text-center text-xs", t.muted)}>没有匹配的文件或目录</div>}
          </div>
        </div>}
        {commands.length > 0 && <Button aria-label="Agent commands" className={cn("size-7 px-0 text-xs", t.muted)} onClick={() => onCommandOpen(!commandOpen)} size="icon" variant="ghost"><span>/</span></Button>}
        {commandOpen && visibleCommands.length > 0 && <div className={cn("absolute bottom-[calc(100%+0.5rem)] left-3 z-30 max-h-72 w-[420px] overflow-y-auto rounded-lg border p-1", t.surface, t.lineStrong, t.shadow)}>{visibleCommands.map((command) => <button className={cn("grid w-full gap-0.5 rounded-md px-3 py-2.5 text-left hover:opacity-80", t.ink)} key={command.name} onClick={() => { onDraft(applyComposerSuggestion(draft, `/${command.name} `)); onCommandOpen(false); }} type="button"><span className="font-mono text-xs">/{command.name}</span><span className={cn("truncate text-[10px]", t.muted)}>{command.description}</span></button>)}</div>}
      </div>
      <Button aria-label="发送" className={cn("size-8 px-0", t.accent, t.accentText)} disabled={disabled || sending || !draft.trim()} onClick={onSubmit} size="icon">{sending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
    </div>
  </div>;
}

function ProjectionItem({ approvals, cwd, item, onApproval, theme }: { approvals: ApprovalRecord[]; cwd: string | null; item: ConversationProjection; onApproval: (item: ApprovalProjection, approve: boolean) => Promise<void>; theme: Theme }) {
  const t = themes[theme];
  if (item.kind === "user") return <article className="grid justify-items-end gap-2"><span className={cn("text-[10px] font-medium uppercase tracking-[0.08em]", t.muted)}>You</span><div className={cn("max-w-[72%] rounded-xl px-3.5 py-3 text-sm leading-6", t.ink, t.accentSoft)}>{item.content}</div></article>;
  if (item.kind === "assistant") return <article className="grid max-w-[780px] gap-2"><span className={cn("text-[10px] font-medium uppercase tracking-[0.08em]", t.muted)}>Agent</span><Markdown content={item.content} theme={theme} /></article>;
  if (item.kind === "work") return <WorkActivity cwd={cwd} item={item} theme={theme} />;
  if (item.kind === "plan") return <section className={cn("max-w-[760px] rounded-lg border", t.surface, t.line, t.shadowSmall)}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", t.line)}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", t.ink)}><Check className={cn("size-3.5", t.muted)} />Plan</span><span className={cn("font-mono text-[10px]", t.muted)}>{item.entries.filter((entry) => entry.status === "completed").length} / {item.entries.length}</span></div><ol className="grid gap-2 px-3.5 py-3.5">{item.entries.map((entry, index) => <li className={cn("flex items-start gap-2 text-xs", entry.status === "completed" ? t.muted : t.inkSoft)} key={`${entry.content}-${index}`}>{entry.status === "completed" ? <Check className={cn("mt-0.5 size-3.5 shrink-0", t.success)} /> : <Circle className={cn("mt-0.5 size-3.5 shrink-0", entry.status === "in_progress" ? t.warning : t.faint)} />}<span>{entry.content}</span></li>)}</ol></section>;
  if (item.kind === "approval") {
    const approval = approvals.find((record) => record.id === item.requestId) ?? approvals.find((record) => record.run_id === item.runId);
    return <ApprovalCard approval={approval} item={item} onApproval={onApproval} theme={theme} />;
  }
  if (item.kind === "error") return <section className={cn("flex max-w-[760px] items-start gap-2 rounded-lg border p-3.5 text-xs", t.dangerSoft, t.danger, t.lineStrong)}><X className="mt-0.5 size-3.5 shrink-0" /><div><p className="font-semibold">{item.fatal ? "Run failed" : "Agent error"}</p><p className="mt-1 leading-5">{item.content}</p></div></section>;
}

function WorkActivity({ cwd, item, theme }: { cwd: string | null; item: WorkProjection; theme: Theme }) {
  const t = themes[theme];
  const tools = item.entries.filter((entry): entry is ToolProjection => entry.kind === "tool");
  const running = item.running;
  return <details open={running || undefined} className={cn("group w-full max-w-[780px] border-t", t.line)}>
    <summary className={cn("flex cursor-pointer list-none items-center gap-2 py-3 text-[11px]", t.muted)}>
      <span className={cn("font-medium", t.inkSoft)}>{running ? "Working" : `Worked for ${formatElapsed(item.startedAt, item.endedAt)}`}</span>
      {tools.length > 0 && <span>{tools.length} tool {tools.length === 1 ? "call" : "calls"}</span>}
      <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
    </summary>
    <div className="grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-2 overflow-hidden pb-4">
      {item.entries.map((entry, index) => entry.kind === "tool"
        ? <div className="w-full min-w-0 max-w-full pl-6" key={entry.id}><ToolActivity cwd={cwd} theme={theme} tool={entry} /></div>
        : <div className="grid w-full min-w-0 max-w-full grid-cols-[18px_minmax(0,1fr)] gap-2 overflow-hidden px-1 py-1" key={`${entry.kind}-${index}`}><span className={cn("mt-1 size-1.5 rounded-full", entry.kind === "thought" ? t.warning : t.faint)} /><div className="min-w-0"><p className={cn("mb-1 text-[10px] font-medium uppercase tracking-[0.08em]", entry.kind === "thought" ? t.warning : t.muted)}>{entry.kind === "thought" ? "Reasoning" : "Progress"}</p><WorkMarkdown content={entry.content} theme={theme} /></div></div>)}
    </div>
  </details>;
}

function WorkMarkdown({ content, theme }: { content: string; theme: Theme }) {
  const t = themes[theme];
  return <div className={cn("max-w-full break-words text-xs font-normal leading-5", t.inkSoft)}><ReactMarkdown components={{
    code: ({ children }) => <code className={cn("rounded px-1 py-0.5 font-mono text-[0.92em]", t.surfaceSoft, t.ink)}>{children}</code>,
    h1: ({ children }) => <h1 className="mb-1 text-xs font-medium leading-5">{children}</h1>,
    h2: ({ children }) => <h2 className="mb-1 text-xs font-medium leading-5">{children}</h2>,
    h3: ({ children }) => <h3 className="mb-1 text-xs font-medium leading-5">{children}</h3>,
    ol: ({ children }) => <ol className="my-1 list-decimal space-y-0.5 pl-4">{children}</ol>,
    p: ({ children }) => <p className="mb-1 last:mb-0">{children}</p>,
    ul: ({ children }) => <ul className="my-1 list-disc space-y-0.5 pl-4">{children}</ul>,
  }} remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>;
}

function ToolActivity({ cwd, theme, tool }: { cwd: string | null; theme: Theme; tool: ToolProjection }) {
  const t = themes[theme];
  const presentation = describeTool(tool, cwd);
  const ToolIcon = presentation.category === "command" ? Terminal : presentation.category === "file" ? FileText : Wrench;
  const status = tool.status === "failed" ? "Failed" : tool.status === "completed" ? "Completed" : "Running";
  return <details className={cn("group/tool rounded-md border", t.surfaceTint, t.line)}>
    <summary className={cn("flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-xs", t.muted)}>
      <span className="grid size-4 shrink-0 place-items-center"><ToolIcon className="size-3.5" /></span>
      <span className={cn("shrink-0 font-medium", t.inkSoft)}>{presentation.label}</span>
      {presentation.target && <span className={cn("min-w-0 flex-1 truncate font-mono text-[10px]", t.muted)} title={presentation.target}>{presentation.target}</span>}
      <span className={cn("text-[10px]", tool.status === "failed" ? t.danger : tool.status === "completed" ? t.success : t.warning)}>{status}</span>
      <ChevronDown className="size-3.5 shrink-0 transition-transform group-open/tool:rotate-180" />
    </summary>
    <div className={cn("grid gap-3 border-t px-3 py-3", t.line)}>
      {presentation.target && presentation.category === "file" && <div className={cn("flex items-start gap-2 font-mono text-[10px] leading-5", t.inkSoft)}><FileText className="mt-0.5 size-3.5 shrink-0" /><span className="break-all">{presentation.target}</span></div>}
      {tool.input !== undefined && <div><p className={cn("mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em]", t.muted)}>Input</p><pre className={cn("max-h-48 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5", t.inkSoft)}>{formatValue(tool.input)}</pre></div>}
      {tool.output !== undefined && <div><p className={cn("mb-1.5 text-[10px] font-medium uppercase tracking-[0.08em]", t.muted)}>Output</p><pre className={cn("max-h-64 overflow-auto whitespace-pre-wrap font-mono text-[10px] leading-5", t.inkSoft)}>{formatValue(tool.output)}</pre></div>}
    </div>
  </details>;
}

function ApprovalCard({ approval, item, onApproval, theme }: { approval: ApprovalRecord | undefined; item: ApprovalProjection; onApproval: (item: ApprovalProjection, approve: boolean) => Promise<void>; theme: Theme }) {
  const t = themes[theme];
  if (approval && approval.status !== "requested") return <section className={cn("max-w-[760px] rounded-lg border p-3.5", t.surface, t.line, t.shadowSmall)}><div className={cn("flex items-center gap-2 text-xs font-semibold", approval.status === "granted" ? t.success : t.danger)}>{approval.status === "granted" ? <Check className="size-3.5" /> : <X className="size-3.5" />}{approval.status === "granted" ? "Approved" : "Run paused"}<span className={cn("ml-auto font-mono text-[10px] font-normal", t.muted)}>{approval.status}</span></div></section>;
  return <section className={cn("max-w-[760px] rounded-lg border", t.surface, t.lineStrong, t.shadowSmall)}><div className={cn("flex items-center justify-between gap-3 border-b px-3.5 py-3", t.line)}><span className={cn("flex items-center gap-2 text-[11px] font-semibold", t.ink)}><ShieldAlert className={cn("size-3.5", t.warning)} />Needs approval</span><span className={cn("font-mono text-[10px]", t.muted)}>scoped to this Run</span></div><div className={cn("px-3.5 pb-1 pt-3 text-xs leading-5", t.inkSoft)}>{item.title}</div><div className="flex gap-2 px-3.5 pb-3.5 pt-2"><Button className={cn("h-8 text-xs", t.accent, t.accentText)} disabled={!approval} onClick={() => void onApproval(item, true)} size="sm">Allow once</Button><Button className={cn("h-8 border text-xs", t.surface, t.ink, t.lineStrong)} disabled={!approval} onClick={() => void onApproval(item, false)} size="sm" variant="outline">Deny</Button></div></section>;
}

const Markdown = memo(function Markdown({ content, theme }: { content: string; theme: Theme }) {
  const t = themes[theme];
  return <div className={cn("max-w-[780px] text-sm font-normal leading-7 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-2", t.inkSoft)}><ReactMarkdown components={{
    a: ({ children, href }) => <a className={cn("underline underline-offset-4", t.ink)} href={href} rel="noreferrer" target="_blank">{children}</a>,
    blockquote: ({ children }) => <blockquote className={cn("my-3 border-l-2 pl-3", t.lineStrong, t.muted)}>{children}</blockquote>,
    code: ({ children, className }) => className?.includes("language-mermaid")
      ? <MermaidDiagram source={String(children).trimEnd()} theme={theme} />
      : <code className={cn("rounded px-1 py-0.5 font-mono text-[0.9em]", t.surfaceSoft, t.ink)}>{children}</code>,
    h1: ({ children }) => <h1 className={cn("mb-3 mt-5 text-lg font-medium", t.ink)}>{children}</h1>,
    h2: ({ children }) => <h2 className={cn("mb-2 mt-5 text-base font-medium", t.ink)}>{children}</h2>,
    h3: ({ children }) => <h3 className={cn("mb-2 mt-4 text-sm font-medium", t.ink)}>{children}</h3>,
    ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-5">{children}</ol>,
    p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
    pre: ({ children }) => isValidElement(children) && children.type === MermaidDiagram
      ? children
      : <pre className={cn("my-3 max-w-full overflow-auto rounded-lg border p-3 font-mono text-xs leading-6", t.surfaceTint, t.line)}>{children}</pre>,
    table: ({ children }) => <div className="my-3 overflow-auto"><table className={cn("w-full border-collapse text-left text-xs [&_td]:border-b [&_td]:p-2 [&_th]:border-b [&_th]:p-2", t.line)}>{children}</table></div>,
    ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-5">{children}</ul>,
  }} rehypePlugins={[rehypeKatex]} remarkPlugins={[remarkGfm, remarkMath]}>{content}</ReactMarkdown></div>;
});

function LoadingConversation({ theme }: { theme: Theme }) {
  const t = themes[theme];
  return <div className="grid gap-5" aria-label="正在加载 Session"><div className={cn("h-3 w-24 animate-pulse rounded", t.surfaceSoft)} /><div className={cn("h-16 w-2/3 animate-pulse rounded-lg", t.surfaceSoft)} /><div className={cn("ml-auto h-12 w-1/2 animate-pulse rounded-lg", t.surfaceSoft)} /></div>;
}

function ContextChip({ label, theme }: { label: string; theme: Theme }) {
  const t = themes[theme];
  return <span className={cn("inline-flex min-h-6 max-w-44 shrink-0 items-center rounded border px-2 text-[10px]", t.surfaceSoft, t.line)}><span className={cn("truncate font-medium", t.inkSoft)}>{label}</span></span>;
}

function ReasoningLevelControl({ onValue, option, theme, value }: { onValue: (value: string) => void; option: ConfigOption; theme: Theme; value: string }) {
  const t = themes[theme];
  const selectableLevels = option.values.filter((candidate) => candidate.value.toLowerCase() !== "default");
  const levels = selectableLevels.length ? selectableLevels : option.values;
  const effectiveValue = value || option.currentValue || levels[0]?.value || "";
  const committedIndex = Math.max(0, levels.findIndex((candidate) => candidate.value === effectiveValue));
  const [previewIndex, setPreviewIndex] = useState(committedIndex);
  useEffect(() => setPreviewIndex(committedIndex), [committedIndex]);
  const active = levels[previewIndex] ?? levels[0]!;
  const activeLabel = `${active.name || active.value}${value ? "" : " · Default"}`;
  return <Popover>
    <PopoverTrigger asChild>
      <Button aria-label={option.name} className={cn("h-6 max-w-44 shrink-0 gap-1 border px-2 py-0 text-[10px] shadow-none", t.surfaceSoft, t.inkSoft, t.line, t.controlHover)} title={activeLabel} type="button" variant="outline"><Zap className="size-3" /><span className="truncate">{activeLabel}</span><ChevronDown className="size-3 opacity-60" /></Button>
    </PopoverTrigger>
    <PopoverContent align="start" className={cn("w-72", t.surface, t.inkSoft, t.lineStrong, t.shadow)} side="top">
      <div className="mb-5 flex items-center justify-between gap-3"><span className={cn("text-xs font-medium", t.ink)}>Reasoning</span><span className="flex min-w-0 items-center gap-2">{value && <span className={cn("text-[10px] underline underline-offset-2", t.muted)}><button onClick={() => onValue("")}>Use default</button></span>}<span className={cn("truncate text-[10px]", t.muted)}>{activeLabel}</span></span></div>
      <div className="relative py-1">
        <div className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 justify-between">{levels.map((level, index) => <span className={cn("size-1 rounded-full bg-current motion-safe:transition-[color,transform] motion-safe:duration-150", previewIndex >= index ? t.controlAccent : t.faint, previewIndex === index && "scale-150")} key={`${level.value}-${index}`} />)}</div>
        <Slider aria-label="Reasoning level" className={t.controlAccent} max={levels.length - 1} min={0} onValueChange={([index]) => setPreviewIndex(index ?? 0)} onValueCommit={([index]) => onValue(levels[index ?? 0]?.value ?? "")} step={1} value={[previewIndex]} />
      </div>
      <div className={cn("mt-3 flex justify-between text-[9px]", t.faint)}><span>{levels[0]?.name}</span><span>{levels.at(-1)?.name}</span></div>
      <p className={cn("mt-3 min-h-4 text-[10px] leading-4", t.muted)}>{active.description ?? "Agent-provided reasoning level"}</p>
    </PopoverContent>
  </Popover>;
}

function SpeedControl({ onValue, option, overridden, theme, value }: { onValue: (value: string) => void; option: ConfigOption; overridden: boolean; theme: Theme; value: string }) {
  const t = themes[theme];
  const selected = option.values.find((candidate) => candidate.value === value);
  const label = `${speedValueLabel(selected?.value ?? value, selected?.name)}${overridden ? "" : " · Default"}`;
  return <Select onValueChange={(next) => onValue(next === DEFAULT_SELECT_VALUE ? "" : next)} value={overridden ? value : DEFAULT_SELECT_VALUE}>
    <SelectTrigger aria-label="Speed" className={cn("h-6 max-w-44 shrink-0 gap-1 border px-2 py-0 text-[10px] shadow-none focus-visible:ring-1", t.surfaceSoft, t.inkSoft, t.line, t.focus)} title={selected?.description}><Gauge className="size-3" /><SelectValue>{label}</SelectValue></SelectTrigger>
    <SelectContent className={cn("max-w-80", t.surface, t.inkSoft, t.lineStrong, t.shadow)}>
      <SelectItem className={t.menuItemFocus} value={DEFAULT_SELECT_VALUE}>{speedValueLabel(option.currentValue ?? "false")} · Default</SelectItem>
      {option.values.map((candidate) => <SelectItem className={t.menuItemFocus} key={candidate.value} textValue={speedValueLabel(candidate.value, candidate.name)} value={candidate.value}><span className="grid gap-0.5 py-0.5"><span>{speedValueLabel(candidate.value, candidate.name)}</span><span className={cn("max-w-72 text-[10px] font-normal leading-4", t.muted)}>{candidate.description ?? (speedValueLabel(candidate.value, candidate.name) === "Fast" ? "Faster responses with higher quota usage" : "Standard response speed")}</span></span></SelectItem>)}
    </SelectContent>
  </Select>;
}

function SessionConfigSelect({ label, onValue, option, theme, value }: { label: string; onValue: (value: string) => void; option: ConfigOption; theme: Theme; value: string }) {
  const t = themes[theme];
  const selected = option.values.find((candidate) => candidate.value === value);
  const triggerLabel = selected ? selected.name || selected.value : label;
  return <Select onValueChange={(next) => onValue(next === DEFAULT_SELECT_VALUE ? "" : next)} value={value || DEFAULT_SELECT_VALUE}>
    <SelectTrigger aria-label={option.name} className={cn("h-6 max-w-52 shrink-0 gap-1 border px-2 py-0 text-[10px] shadow-none focus-visible:ring-1", t.surfaceSoft, t.inkSoft, t.line, t.focus)} title={selected?.description}><SelectValue>{triggerLabel}</SelectValue></SelectTrigger>
    <SelectContent className={cn("max-w-80", t.surface, t.inkSoft, t.lineStrong, t.shadow)}>
      <SelectItem className={t.menuItemFocus} value={DEFAULT_SELECT_VALUE}>{label}</SelectItem>
      {option.values.map((candidate) => <SelectItem className={t.menuItemFocus} key={candidate.value} textValue={candidate.name || candidate.value} value={candidate.value}><span className="grid gap-0.5 py-0.5"><span>{candidate.name || candidate.value}</span>{candidate.description && <span className={cn("max-w-72 text-[10px] font-normal leading-4", t.muted)}>{candidate.description}</span>}</span></SelectItem>)}
    </SelectContent>
  </Select>;
}

function MenuButton({ children, danger = false, disabled = false, onClick, theme }: { children: ReactNode; danger?: boolean; disabled?: boolean; onClick: () => void; theme: Theme }) {
  const t = themes[theme];
  return <Button className={cn("w-full justify-start text-xs", danger ? t.danger : t.inkSoft)} disabled={disabled} onClick={onClick} size="sm" variant="ghost">{children}</Button>;
}

function defaultModelLabel(option: ConfigOption): string {
  const current = option.values.find((candidate) => candidate.value === option.currentValue);
  return current ? `${current.name || current.value} · Default` : "Agent default";
}

function projectionKey(item: ConversationProjection, index: number): string {
  if (item.kind === "work") return item.id;
  if (item.kind === "user") return item.eventId;
  if (item.kind === "approval") return item.requestId;
  return `${item.kind}-${item.runId ?? "session"}-${index}`;
}

function formatElapsed(startedAt: string, endedAt: string): string {
  const seconds = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function workspaceLabel(session: AgentSession | null): string {
  if (!session) return "Workspace";
  const path = session.additional_directories.at(-1) ?? session.cwd;
  if (!path) return "Add workspace";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function relativeTime(value: string): string {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return "now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function readTheme(): Theme {
  const stored = window.localStorage.getItem("codebridge:web-theme");
  if (stored === "paper" || stored === "carbon") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "carbon" : "paper";
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function readAttachment(file: File): Promise<MessageAttachmentInput> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const dataBase64 = result.includes(",") ? result.slice(result.indexOf(",") + 1) : result;
      resolve({ name: file.name, mimeType: file.type || "application/octet-stream", dataBase64 });
    };
    reader.readAsDataURL(file);
  });
}
