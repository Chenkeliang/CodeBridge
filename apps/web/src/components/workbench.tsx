import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { BrandAgentIcon } from "@/components/brand-agent-icon";
import { CommandPalette } from "@/components/command-palette";
import { Composer } from "@/components/composer";
import { LoadingConversation, ProjectionItem } from "@/components/conversation";
import { SettingsPage } from "@/components/settings-page";
import { PixelMark } from "@/components/pixel-mark";
import { AgentRail, SessionHeader, SessionPanel } from "@/components/session-chrome";
import { api, streamSessionEvents } from "@/lib/api";
import { reduceConversationEvents, type ApprovalProjection } from "@/lib/events";
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
import { applyComposerSuggestion, composerTrigger, isModelOption, isPermissionOption, isSpeedOption, isThoughtLevelOption, mergeConversationEvents, orderSessions, restoreSessionSelection, selectInitialAgent, serializeConfigOverride, workspacePaths } from "@/lib/workbench-logic";
import { messageOf, projectionKey, statusLabel, type Density, type MenuView, type PanelArea, type Theme } from "@/components/workbench-shared";

export function Workbench() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [area, setArea] = useState<PanelArea>("agents");
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [effectiveDefaultAgentId, setEffectiveDefaultAgentId] = useState<string | null>(null);
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
  const [notice, setNotice] = useState<{ text: string; kind: "info" | "error" } | null>(null);
  const pendingEvents = useRef<Record<string, SessionEvent[]>>({});
  const sessionCache = useRef<Record<string, {
    session: AgentSession;
    events: SessionEvent[];
    commands: AgentCommand[];
    options: ConfigOption[];
    approvals: ApprovalRecord[];
  }>>({});
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

  const selectedSession = sessions.find((session) => session.session_id === selectedSessionId) ?? null;
  const selectedAgent = agents.find((agent) => agent.agent_id === (selectedSession?.agent_id ?? selectedAgentId)) ?? null;
  const selectedAgentSetup = selectedAgent?.setup ?? null;
  const selectedAgentManifest = selectedAgent?.setup_manifest ?? null;
  const selectedAgentNeedsSetup = Boolean(selectedAgent && selectedAgent.status === "needs_setup" && !selectedSession);
  const selectedAgentUnavailable = Boolean(selectedAgent && selectedAgent.status === "unavailable" && !selectedSession);
  const agentSessions = useMemo(
    () => orderSessions(sessions.filter((session) => session.agent_id === selectedAgentId))
      .filter((session) => showArchived ? Boolean(session.archived_at) : !session.archived_at)
      .filter((session) => (session.title || "未命名 Session").toLowerCase().includes(query.toLowerCase())),
    [query, selectedAgentId, sessions, showArchived],
  );
  const activeSessionCount = sessions.filter((session) => session.agent_id === selectedAgentId && !session.archived_at).length;
  const archivedSessionCount = sessions.filter((session) => session.agent_id === selectedAgentId && session.archived_at).length;
  const projection = useMemo(() => reduceConversationEvents(events), [events]);
  const sessionRunning = useMemo(() => projection.some((item) => item.kind === "work" && item.running), [projection]);
  const modelOption = useMemo(() => configOptions.find(isModelOption), [configOptions]);
  const thoughtLevelOption = useMemo(() => configOptions.find(isThoughtLevelOption), [configOptions]);
  const speedOption = useMemo(() => configOptions.find(isSpeedOption), [configOptions]);
  const permissionOption = useMemo(() => configOptions.find(isPermissionOption), [configOptions]);

  const notify = useCallback((message: string, kind: "info" | "error" = "info") => {
    setNotice({ text: message, kind });
    window.setTimeout(() => setNotice((current) => current?.text === message ? null : current), 4000);
  }, []);

  const reload = useCallback(async (importProvider = false, silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      const [agentList, nextSessions, nextFlows] = await Promise.all([
        api.agents(),
        api.sessions(importProvider, true),
        api.flows(),
      ]);
      const nextAgents = agentList.agents;
      setAgents(nextAgents);
      setDefaultAgentId(agentList.default_agent_id);
      setEffectiveDefaultAgentId(agentList.effective_default_agent_id);
      setSessions(nextSessions);
      setFlows(nextFlows.filter((flow) => flow.status !== "deprecated"));
      const nextAgentId = selectedAgentRef.current && nextAgents.some((agent) => agent.agent_id === selectedAgentRef.current)
        ? selectedAgentRef.current
        : selectInitialAgent(nextAgents, agentList.effective_default_agent_id);
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
    // The boot script in index.html primes <html data-theme> before first paint;
    // it must follow runtime switches too or <body>/scrollbars keep the old theme.
    document.documentElement.dataset.theme = theme;
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
    // Stale-while-revalidate: paint the cached snapshot instantly, refresh below.
    const cached = sessionCache.current[sessionId];
    setLoadingSession(!cached);
    setEvents(cached ? mergeConversationEvents(cached.events, pendingEvents.current[sessionId] ?? []) : (pendingEvents.current[sessionId] ?? []));
    if (cached) {
      setCommands(cached.commands);
      setConfigOptions(cached.options);
      setApprovals(cached.approvals);
      setModel(cached.session.model ?? "");
      setEffort(cached.session.effort ?? "");
      setConfigOverrides(cached.session.config_overrides ?? {});
      setPermissionMode(cached.session.permission_mode ?? "");
      setFlowId(cached.session.flow_id ?? "");
    }
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
        const nextApprovals = latestRun ? await api.approvals(latestRun.run_id).catch(() => []) : [];
        if (!active) return;
        setApprovals(nextApprovals);
        sessionCache.current[sessionId] = { session, events: history, commands: nextCommands, options, approvals: nextApprovals };
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

  const [stuckToBottom, setStuckToBottom] = useState(true);
  const sessionSwitch = useRef(true);

  useEffect(() => {
    sessionSwitch.current = true;
    setStuckToBottom(true);
  }, [selectedSessionId]);

  useEffect(() => {
    if (loadingSession || !selectedSessionId || !conversationViewport.current) return;
    if (!sessionSwitch.current && !stuckToBottom) return;
    const frame = window.requestAnimationFrame(() => {
      const viewport = conversationViewport.current;
      if (viewport) {
        viewport.scrollTop = viewport.scrollHeight;
        sessionSwitch.current = false;
        setStuckToBottom(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events, selectedSessionId, loadingSession, sending, stuckToBottom]);

  function handleConversationScroll() {
    const viewport = conversationViewport.current;
    if (!viewport) return;
    setStuckToBottom(viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 80);
  }

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const [density, setDensity] = useState<Density>(() => window.localStorage.getItem("codebridge:web-density") === "comfortable" ? "comfortable" : "compact");
  const [reading, setReading] = useState(() => window.localStorage.getItem("codebridge:web-reading") === "serif");

  useEffect(() => { window.localStorage.setItem("codebridge:web-density", density); }, [density]);
  useEffect(() => { window.localStorage.setItem("codebridge:web-reading", reading ? "serif" : "sans"); }, [reading]);

  function toggleTheme() {
    const next = theme === "paper" ? "carbon" : "paper";
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    // View Transitions crossfade a captured frame, so the theme flip never
    // reads as a full re-render; fall back to an instant switch.
    const startViewTransition = (document as Document & { startViewTransition?: (update: () => void) => void }).startViewTransition;
    if (reduced || !startViewTransition) { setTheme(next); return; }
    startViewTransition.call(document, () => setTheme(next));
  }

  useEffect(() => {
    function onGlobalKey(event: globalThis.KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === "k" || event.key === "K") {
        event.preventDefault();
        setPaletteOpen((current) => !current);
      }
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        const agentId = selectedAgentRef.current;
        if (agentId) void createSession(agentId);
      }
    }
    window.addEventListener("keydown", onGlobalKey);
    return () => window.removeEventListener("keydown", onGlobalKey);
  });

  const [pixelWipe, setPixelWipe] = useState(0);

  function selectAgent(agentId: string) {
    if (agentId !== selectedAgentRef.current && !window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setPixelWipe((value) => value + 1);
      window.setTimeout(() => setPixelWipe(0), 650);
    }
    selectedAgentRef.current = agentId;
    setSelectedAgentId(agentId);
    setArea("agents");
    setQuery("");
    setShowArchived(false);
    const remembered = window.localStorage.getItem(`codebridge:last-session:${agentId}`);
    const nextSessionId = restoreSessionSelection(sessions, selectedSessionRef.current, agentId, remembered);
    selectedSessionRef.current = nextSessionId;
    // Composer config (model/effort/options) is per-Agent: if the session id
    // doesn't change (both null), the load effect won't rerun and the previous
    // Agent's options would leak into this one's selector.
    if (nextSessionId === selectedSessionId && agentId !== selectedAgentId) {
      setCommands([]);
      setConfigOptions([]);
      setModel("");
      setEffort("");
      setConfigOverrides({});
      setPermissionMode("");
    }
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

  async function stopRun() {
    if (!selectedSessionId) return;
    try {
      const result = await api.cancelRun(selectedSessionId);
      notify(result.stopped ? "已请求停止当前 Run" : "当前没有正在运行的 Run", result.stopped ? "info" : "error");
    } catch (caught) {
      notify(messageOf(caught), "error");
    }
  }

  async function submit() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    let sessionId = selectedSessionId;
    if (!sessionId) {
      if (!selectedAgent || selectedAgent.status !== "healthy") {
        setError(selectedAgent
          ? `${selectedAgent.display_name} 当前不可用（${statusLabel[selectedAgent.status] ?? selectedAgent.status}），请先在设置中完成安装/配置`
          : "请选择一个可用的 Agent");
        setSending(false);
        return;
      }
      sessionId = (await createSession(selectedAgent.agent_id))?.session_id ?? null;
    }
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
      if (sessionCache.current[sessionId]) sessionCache.current[sessionId].session = updated;
      setSessions((current) => current.map((session) => session.session_id === updated.session_id ? updated : session));
      if (selectedSessionId === sessionId) {
        setModel(updated.model ?? "");
        setEffort(updated.effort ?? "");
        setConfigOverrides(updated.config_overrides ?? {});
        setPermissionMode(updated.permission_mode ?? "");
        // Model capabilities differ per model — refetch options so the
        // reasoning/speed controls follow the new model (agent-providers §2.6).
        if (Object.hasOwn(update, "model")) {
          const nextOptions = await api.configOptions(sessionId).catch(() => null);
          if (nextOptions) setConfigOptions(nextOptions);
        }
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
      delete sessionCache.current[sessionId];
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

  async function detectSelectedAgent() {
    if (!selectedAgent) return;
    try {
      await api.detectAgent(selectedAgent.agent_id);
      await reload(false, true);
      notify(`${selectedAgent.display_name} 已重新检测`);
    } catch (caught) {
      notify(messageOf(caught), "error");
    }
  }

  async function setSelectedAgentDefault() {
    if (!selectedAgent || !selectedAgentSetup?.can_select_default) return;
    try {
      await api.setDefaultAgent(selectedAgent.agent_id);
      await reload(false, true);
      notify(`${selectedAgent.display_name} 已设为默认`);
    } catch (caught) {
      notify(messageOf(caught), "error");
    }
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

  function handleDraftChange(value: string) {
    const nextTrigger = composerTrigger(value);
    setCommandOpen(nextTrigger?.kind === "command" && commands.length > 0);
    // Opening the context popup via typing "@" must also load the listing;
    // previously only the toolbar "@" button fetched it, leaving an empty panel.
    const openContext = nextTrigger?.kind === "context" && workspacePaths(selectedSession).length > 0;
    setContextOpen(openContext);
    if (openContext && !workspaceListing && selectedSessionId) void browseWorkspace();
    setDraft(value);
  }

  return (
    <div className={cn("grid h-[100dvh] min-h-[100dvh] overflow-hidden font-sans text-sm tracking-[-0.01em]", panelOpen && area !== "settings" ? "grid-cols-[60px_286px_minmax(0,1fr)]" : "grid-cols-[60px_minmax(0,1fr)]", "bg-canvas text-ink")} data-density={density} data-reading={reading ? "serif" : "sans"} data-theme={theme}>
      <AgentRail
        agents={agents}
        area={area}
        selectedAgentId={selectedAgentId}
        theme={theme}
        onAgent={selectAgent}
        onArea={setArea}
        onTheme={toggleTheme}
      />

      {panelOpen && area !== "settings" && <SessionPanel
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
        onCreate={() => selectedAgent && void createSession(selectedAgent.agent_id)}
        onFlow={(id) => { setFlowId(id); setArea("agents"); }}
        onQuery={setQuery}
        onRefresh={() => void reload(true)}
        onSession={selectSession}
        onUpdateSession={(session, update) => applySessionUpdate(session.session_id, update)}
        onDeleteSession={(session) => deleteSessionById(session.session_id)}
        onToggleArchived={() => setShowArchived((current) => !current)}
        showArchived={showArchived}
      />}

      <main className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", "bg-canvas text-ink")}>
        {pixelWipe > 0 && <PixelWipe key={pixelWipe} seed={pixelWipe} />}
        {area !== "settings" && <SessionHeader
          agent={selectedAgent}
          session={selectedSession}
          menuOpen={menuOpen}
          menuView={menuView}
          panelOpen={panelOpen}
          renameDraft={renameDraft}
          onDelete={() => void deleteSelected()}
          onTogglePanel={() => setPanelOpen((current) => !current)}
          onMenu={() => { setMenuOpen((current) => !current); setMenuView("actions"); }}
          onMenuView={setMenuView}
          onRenameDraft={setRenameDraft}
          onUpdate={(update) => void updateSession(update)}
        />}

        {error && <div className={cn("mx-8 mt-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs", "bg-danger-soft", "text-danger", "border-line-strong")} role="alert"><X className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button aria-label="关闭错误" onClick={() => setError(null)} type="button"><X className="size-3.5" /></button></div>}

        {area === "settings" ? (
          <section aria-label="设置" className="min-h-0 flex-1 overflow-y-auto">
            <SettingsPage
              density={density}
              agents={agents}
              defaultAgentId={defaultAgentId}
              effectiveDefaultAgentId={effectiveDefaultAgentId}
              onAgentsChanged={() => reload(false, true)}
              reading={reading}
              onDensity={setDensity}
              onNotify={notify}
              onProvidersChanged={() => {
                if (selectedSession?.agent_id !== "pi") return;
                void api.configOptions(selectedSession.session_id)
                  .then(setConfigOptions)
                  .catch((caught) => setError(messageOf(caught)));
              }}
              onReading={setReading}
            />
          </section>
        ) : !selectedSession ? selectedAgentNeedsSetup || selectedAgentUnavailable ? (
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-20">
            <div className="w-full max-w-[760px]">
              <div className="mb-7 text-center">
                <div className={cn("mx-auto mb-4 grid size-10 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")}>{selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id} className="size-[18px]" /> : <PixelMark className="size-5" />}</div>
                <h1 className={cn("font-brand text-2xl font-normal leading-none tracking-normal", "text-ink")}>{selectedAgent ? selectedAgent.display_name : "CodeBridge"}</h1>
                <p className={cn("mt-2 text-xs", "text-muted")}>
                  {selectedAgentNeedsSetup
                    ? "先完成安装或配置后再创建 Session"
                    : "Agent 当前运行不可用，先排查诊断"}
                </p>
              </div>
              <div className={cn("grid gap-3 rounded-xl border px-5 py-5", "bg-surface", "border-line-strong")}>
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <span className={cn("rounded-full border px-2 py-0.5", "bg-surface-soft", "text-ink-soft", "border-line")}>{statusLabel[selectedAgent?.status ?? "needs_setup"] ?? selectedAgent?.status ?? "未知"}</span>
                  {selectedAgentSetup?.version && <span className="text-muted">版本 {selectedAgentSetup.version}</span>}
                </div>
                <div className="grid gap-1 text-xs leading-5 text-muted">
                  <div>安装：{selectedAgentSetup ? (selectedAgentSetup.installation === "installed" ? "已安装" : selectedAgentSetup.installation === "missing" ? "未安装" : "状态未知") : "未知"}</div>
                  <div>配置：{selectedAgentSetup ? (selectedAgentSetup.configuration === "configured" ? "已配置" : selectedAgentSetup.configuration === "needs_configuration" ? "待配置" : "状态未知") : "未知"}</div>
                  <div>运行：{selectedAgentSetup ? (selectedAgentSetup.runtime === "healthy" ? "健康" : selectedAgentSetup.runtime === "unavailable" ? "不可用" : "未启动") : "未知"}</div>
                  {selectedAgentSetup?.diagnostic && <div className="rounded-lg border border-danger/30 bg-danger-soft px-3 py-2 text-danger">
                    <div>{selectedAgentSetup.diagnostic.stage} · {selectedAgentSetup.diagnostic.code}</div>
                    <div>{selectedAgentSetup.diagnostic.message}</div>
                    {selectedAgentSetup.diagnostic.details && <div className="mt-1 font-mono text-[11px]">{selectedAgentSetup.diagnostic.details}</div>}
                    {selectedAgentSetup.diagnostic.exit_code !== undefined && <div className="mt-1 font-mono text-[11px]">exit code: {selectedAgentSetup.diagnostic.exit_code}</div>}
                  </div>}
                  {selectedAgentManifest?.install_strategies[0] && selectedAgentNeedsSetup && (
                    <div className="rounded-lg border border-line px-3 py-2 font-mono text-xs text-ink-soft">
                      {selectedAgentManifest.install_strategies[0].command} {selectedAgentManifest.install_strategies[0].args.join(" ")}
                    </div>
                  )}
                  {selectedAgentManifest?.configuration_path && <div className="font-mono">{selectedAgentManifest.configuration_path}</div>}
                  {selectedAgentManifest?.documentation_url && <a className="text-accent hover:underline" href={selectedAgentManifest.documentation_url} rel="noreferrer" target="_blank">打开文档</a>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <button className={cn("rounded-md border px-3 py-1.5 text-xs", "bg-surface", "text-ink", "border-line-strong")} onClick={() => setArea("settings")} type="button">打开设置</button>
                  <button className={cn("rounded-md border px-3 py-1.5 text-xs", "bg-surface", "text-ink", "border-line-strong")} onClick={() => void detectSelectedAgent()} type="button">重新检测</button>
                  <button className={cn("rounded-md border px-3 py-1.5 text-xs", "bg-accent", "text-accent-ink", "border-line-strong", !selectedAgentSetup?.can_select_default && "opacity-50")} disabled={!selectedAgentSetup?.can_select_default} onClick={() => void setSelectedAgentDefault()} type="button">设为默认</button>
                </div>
              </div>
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 items-center justify-center px-8 pb-20">
            <div className="w-full max-w-[760px]">
              <div className="mb-7 text-center">
                <div className={cn("mx-auto mb-4 grid size-10 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")}>{selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id} className="size-[18px]" /> : <PixelMark className="size-5" />}</div>
                <h1 className={cn("font-brand text-2xl font-normal leading-none tracking-normal", "text-ink")}>{selectedAgent ? selectedAgent.display_name : "CodeBridge"}</h1>
                <p className={cn("mt-2 text-xs", "text-muted")}>{selectedAgent ? "创建 Session，或直接输入目标" : "选择一个可用的 Agent"}</p>
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
                commandOpen={commandOpen}
                onAddFiles={addFiles}
                onCommandOpen={setCommandOpen}
                onContext={() => undefined}
                onContextNavigate={() => undefined}
                onContextOpen={toggleContext}
                onDraft={handleDraftChange}
                onFiles={() => fileInput.current?.click()}
                onFlow={setFlowId}
                onModel={(value) => { setModel(value); void updateSession({ model: value || null }); }}
                onEffort={setSessionEffort}
                onConfigOverride={setSessionConfigOverride}
                onPermissionMode={setSessionPermissionMode}
                onPickDirectory={() => notify("Session 创建后可添加 Workspace")}
                onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, valueIndex) => valueIndex !== index))}
                onSubmit={() => void submit()}
                onStop={() => void stopRun()}
                running={false}
              />
            </div>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <section aria-label="Session conversation" className="min-h-0 flex-1 overflow-y-auto px-8 pt-7" onScroll={handleConversationScroll} ref={conversationViewport}>
              <div className="mx-auto w-full max-w-[880px] pb-7">
                {loadingSession ? <LoadingConversation /> : projection.length ? (
                  <div className="grid gap-6">
                    {projection.map((item, index) => (
                      <ProjectionItem
                        approvals={approvals}
                        cwd={selectedSession.cwd}
                        item={item}
                        key={projectionKey(item, index)}
                        onApproval={resolveApproval}
                      />
                    ))}
                  </div>
                ) : <div aria-label="Empty Session" className="flex min-h-[42vh] flex-col items-center justify-center text-center">
                  <div className={cn("mb-4 grid size-10 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")}>{selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id} className="size-[18px]" /> : <PixelMark className="size-5" />}</div>
                  <h2 className={cn("font-brand text-xl font-normal tracking-[-0.02em]", "text-ink")}>{selectedSession.title || (selectedAgent ? `${selectedAgent.display_name} Session` : "Session")}</h2>
                  <p className={cn("mt-2 text-xs", "text-muted")}>输入目标开始当前 Session</p>
                </div>}
              </div>
            </section>
            {!stuckToBottom && <button aria-label="回到底部" className={cn("absolute bottom-32 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-xs shadow-panel transition-opacity", "bg-surface", "text-ink-soft", "border-line-strong")} onClick={() => { const viewport = conversationViewport.current; if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }); }} type="button"><ChevronDown className="size-3.5" />回到最新</button>}
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
                  commandOpen={commandOpen}
                  onAddFiles={addFiles}
                  onCommandOpen={setCommandOpen}
                  onContext={(path) => setDraft((current) => applyComposerSuggestion(current, `@${path} `))}
                  onContextNavigate={(path, root) => void browseWorkspace(path, root)}
                  onContextOpen={toggleContext}
                  onDraft={handleDraftChange}
                  onFiles={() => fileInput.current?.click()}
                  onFlow={setFlowId}
                  onModel={(value) => { setModel(value); void updateSession({ model: value || null }); }}
                  onEffort={setSessionEffort}
                  onConfigOverride={setSessionConfigOverride}
                  onPermissionMode={setSessionPermissionMode}
                  onPickDirectory={() => void pickDirectory()}
                  onRemoveAttachment={(index) => setAttachments((current) => current.filter((_, valueIndex) => valueIndex !== index))}
                  onSubmit={() => void submit()}
                  onStop={() => void stopRun()}
                  running={sessionRunning}
                />
              </div>
            </footer>
          </div>
        )}
      </main>

      {paletteOpen && <CommandPalette
        agents={agents}
        canCreate={Boolean(selectedAgent && selectedAgent.status === "healthy")}
        onClose={() => setPaletteOpen(false)}
        onCreateSession={() => { if (selectedAgent) void createSession(selectedAgent.agent_id); }}
        onSelectAgent={(id) => { selectAgent(id); }}
        onSelectSession={selectSession}
        onToggleTheme={toggleTheme}
        sessions={sessions.filter((session) => session.agent_id === selectedAgentId && !session.archived_at)}
      />}
      <input className="hidden" multiple onChange={(event) => { if (event.target.files) void addFiles(event.target.files); event.target.value = ""; }} ref={fileInput} type="file" />
      {notice && <div className={cn("fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-md border px-3 py-2 text-xs", notice.kind === "error" ? cn("bg-danger-soft", "text-danger", "border-line-strong") : cn("bg-surface", "text-ink", "border-line-strong"), "shadow-panel")} role="status">{notice.kind === "error" && <X className="size-3.5 shrink-0" />}{notice.text}</div>}
    </div>
  );
}


/** Pixel-dissolve wipe shown briefly when switching agents: a grid of cells
 *  fading in with pseudo-random delays, then out — opacity only. */
function PixelWipe({ seed }: { seed: number }) {
  const [on, setOn] = useState(false);
  const [out, setOut] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setOn(true));
    const timer = window.setTimeout(() => setOut(true), 400);
    return () => { cancelAnimationFrame(frame); window.clearTimeout(timer); };
  }, []);
  const delays = useMemo(() => Array.from({ length: 60 }, (_, index) => ((index * 73 + seed * 191) % 37) * 8), [seed]);
  return <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-30 grid grid-cols-10 grid-rows-6">
    {delays.map((delay, index) => <span className={cn("bg-canvas transition-opacity duration-150", on && !out ? "opacity-100" : "opacity-0")} key={index} style={{ transitionDelay: `${out ? 0 : delay}ms` }} />)}
  </div>;
}

function readTheme(): Theme {
  const stored = window.localStorage.getItem("codebridge:web-theme");
  if (stored === "paper" || stored === "carbon") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "carbon" : "paper";
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
