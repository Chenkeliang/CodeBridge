import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, X } from "lucide-react";
import { BrandAgentIcon } from "@/components/brand-agent-icon";
import { CommandPalette } from "@/components/command-palette";
import { Composer } from "@/components/composer";
import { LoadingConversation } from "@/components/conversation";
import type {
  RuntimeApprovalAction,
  RuntimeApprovalStatus,
} from "@/components/runtime-approval-card";
import { SessionQueue } from "@/components/session-queue";
import { SessionTimeline } from "@/components/session-timeline";
import { FlowDetail } from "@/components/flow-detail";
import { FlowControlPanel } from "@/components/flow-control-panel";
import { FlowBatchPanel } from "@/components/flow-batch-panel";
import {
  ProviderHistoryImportCard,
  providerHistoryErrorPresentation,
  type ProviderHistoryImportState,
} from "@/components/provider-history-import-card";
import { SettingsPage } from "@/components/settings-page";
import { SkillControlPlanePage } from "@/components/skill-control-plane";
import { PixelMark } from "@/components/pixel-mark";
import { AgentRail, SessionHeader, SessionPanel } from "@/components/session-chrome";
import { api } from "@/lib/api";
import { SessionConnection } from "@/lib/session-connection";
import { sessionViewStore, useSessionView } from "@/lib/session-store";
import { submitSessionMessage } from "@/lib/submit-session-message";
import { defaultsFromFlow, flowRunMessage } from "@/lib/flow-run-submit";
import type {
  AgentCommand,
  AgentProfile,
  AgentSession,
  ConfigOption,
  FlowRecord,
  FlowCapability,
  FlowBatchDraft,
  FlowBatchSnapshot,
  FlowProposal,
  FlowRecommendation,
  FlowReviewContext,
  MessageAttachmentInput,
  ProviderHistoryPreview,
  WorkspaceListing,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { applyComposerSuggestion, composerTrigger, isModelOption, isPermissionOption, isSpeedOption, isThoughtLevelOption, orderSessions, restoreSessionSelection, selectInitialAgent, serializeConfigOverride, workspacePaths } from "@/lib/workbench-logic";
import { messageOf, statusLabel, type Density, type MenuView, type PanelArea, type Theme } from "@/components/workbench-shared";

type FlowRevisionMismatch = {
  source: "binding" | "request";
  flow_id: string;
  expected_definition_revision: string;
  current_definition_revision: string;
};

export function Workbench() {
  const [theme, setTheme] = useState<Theme>(() => readTheme());
  const [area, setArea] = useState<PanelArea>("agents");
  const [agents, setAgents] = useState<AgentProfile[]>([]);
  const [defaultAgentId, setDefaultAgentId] = useState<string | null>(null);
  const [effectiveDefaultAgentId, setEffectiveDefaultAgentId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  const [flows, setFlows] = useState<FlowRecord[]>([]);
  const [consumableFlows, setConsumableFlows] = useState<FlowRecord[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [configOptions, setConfigOptions] = useState<ConfigOption[]>([]);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [configOverrides, setConfigOverrides] = useState<Record<string, string | boolean>>({});
  const [permissionMode, setPermissionMode] = useState("");
  const [pendingFlowId, setPendingFlowId] = useState("");
  const [detailFlow, setDetailFlow] = useState<FlowRecord | null>(null);
  const [flowCapabilities, setFlowCapabilities] = useState<FlowCapability[]>([]);
  const [flowReviewContext, setFlowReviewContext] = useState<FlowReviewContext | null>(null);
  const [flowControlBusy, setFlowControlBusy] = useState(false);
  const [flowControlError, setFlowControlError] = useState<string | null>(null);
  const [savingCandidateRunId, setSavingCandidateRunId] = useState<string | null>(null);
  const [flowProposals, setFlowProposals] = useState<FlowProposal[]>([]);
  const [flowRecommendations, setFlowRecommendations] = useState<FlowRecommendation[]>([]);
  const [savingGuideRunId, setSavingGuideRunId] = useState<string | null>(null);
  const [flowMismatch, setFlowMismatch] = useState<FlowRevisionMismatch | null>(null);
  const [flowBatchDraft, setFlowBatchDraft] = useState<FlowBatchDraft | null>(null);
  const [flowBatch, setFlowBatch] = useState<FlowBatchSnapshot | null>(null);
  const [flowBatchBusy, setFlowBatchBusy] = useState(false);
  const [flowBatchError, setFlowBatchError] = useState<string | null>(null);
  const [resolvingApprovalId, setResolvingApprovalId] = useState<string | null>(null);
  const [approvalStatusOverrides, setApprovalStatusOverrides] = useState<Record<string, RuntimeApprovalStatus>>({});
  const [paramValues, setParamValues] = useState<Record<string, unknown>>({});
  const [missingInputs, setMissingInputs] = useState<Array<{
    id: string; type: string; source: string; reason: string;
  }>>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<MessageAttachmentInput[]>([]);
  const [sending, setSending] = useState(false);
  const pendingSubmissionKey = useRef<string | null>(null);
  const [providerHistory, setProviderHistory] = useState<ProviderHistoryImportState>({ kind: "idle" });
  const providerHistoryRequestVersion = useRef(0);
  const pendingHistoryImportKey = useRef<{ sessionId: string; key: string } | null>(null);
  const providerHistoryPreview = useRef<ProviderHistoryPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [pickingDirectory, setPickingDirectory] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; kind: "info" | "error" } | null>(null);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const [loadingBlockId, setLoadingBlockId] = useState<string | null>(null);
  const [loadingQueue, setLoadingQueue] = useState(false);
  const [cancellingTurnId, setCancellingTurnId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<MenuView>("actions");
  const [renameDraft, setRenameDraft] = useState("");
  const [commandOpen, setCommandOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [workspaceListing, setWorkspaceListing] = useState<WorkspaceListing | null>(null);
  const [workspaceLoading, setWorkspaceLoading] = useState(false);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const guideImportInput = useRef<HTMLInputElement | null>(null);
  const deepLinkHandled = useRef(false);
  const conversationViewport = useRef<HTMLElement | null>(null);
  const selectedAgentRef = useRef<string | null>(null);
  const selectedSessionRef = useRef<string | null>(null);
  const sessionConnection = useMemo(() => new SessionConnection({
    store: sessionViewStore,
    openSession: api.openSession,
  }), []);
  const sessionView = useSessionView(selectedSessionId);
  const activeFlowBatchId = flowBatch?.batch_id ?? null;
  const activeFlowBatchStatus = flowBatch?.status ?? null;
  const proposalRunKey = sessionView?.snapshot.timeline.turns
    .map((turn) => `${turn.run_id}:${turn.status}`)
    .join("|") ?? "";

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
  const sessionRunning = Boolean(sessionView?.snapshot.runtime.active_run);
  const runState = sessionRunning
    ? "running" as const
    : sessionView?.snapshot.runtime.queue_state === "paused"
      ? "paused" as const
      : "idle" as const;
  const modelOption = useMemo(() => configOptions.find(isModelOption), [configOptions]);
  const thoughtLevelOption = useMemo(() => configOptions.find(isThoughtLevelOption), [configOptions]);
  const speedOption = useMemo(() => configOptions.find(isSpeedOption), [configOptions]);
  const permissionOption = useMemo(() => configOptions.find(isPermissionOption), [configOptions]);
  const pendingFlow = consumableFlows.find((flow) => flow.flow_id === pendingFlowId) ?? null;
  const waitingRuntimeApprovals = useMemo(() =>
    sessionView?.snapshot.timeline.turns.flatMap((turn) =>
      turn.blocks.flatMap((block) => {
        const approvalId = typeof block.metadata.approval_id === "string"
          ? block.metadata.approval_id
          : null;
        return block.kind === "approval" && block.status === "waiting" && approvalId
          ? [{ runId: turn.run_id, approvalId }]
          : [];
      }),
    ) ?? [],
  [sessionView?.snapshot.timeline.turns]);
  const detailCandidateFlowId = detailFlow?.status === "candidate" ? detailFlow.flow_id : null;
  const detailEvidenceKey = useMemo(() => {
    if (!detailCandidateFlowId) return "";
    return sessionView?.snapshot.timeline.turns.flatMap((turn) =>
      turn.blocks
        .filter((block) => block.kind === "flow_run" && block.status === "succeeded")
        .filter((block) => block.metadata.flow_id === detailCandidateFlowId)
        .map(() => turn.run_id),
    ).join(":") ?? "";
  }, [detailCandidateFlowId, sessionView?.snapshot.timeline.turns]);
  const notify = useCallback((message: string, kind: "info" | "error" = "info") => {
    setNotice({ text: message, kind });
    window.setTimeout(() => setNotice((current) => current?.text === message ? null : current), 4000);
  }, []);

  const previewProviderHistory = useCallback(async (sessionId: string): Promise<void> => {
    const requestVersion = ++providerHistoryRequestVersion.current;
    setProviderHistory({ kind: "previewing", sessionId });
    try {
      const preview = await api.previewProviderHistory(sessionId);
      if (
        selectedSessionRef.current !== sessionId
        || providerHistoryRequestVersion.current !== requestVersion
      ) return;
      providerHistoryPreview.current = preview;
      if (preview.importableEvents > 0) {
        setProviderHistory({ kind: "available", sessionId, preview });
        return;
      }
      const timelineEmpty = (sessionViewStore.get(sessionId)?.snapshot.timeline.turns.length ?? 0) === 0;
      setProviderHistory(timelineEmpty ? { kind: "empty", sessionId } : { kind: "idle" });
    } catch (caught) {
      if (
        selectedSessionRef.current !== sessionId
        || providerHistoryRequestVersion.current !== requestVersion
      ) return;
      const presentation = providerHistoryErrorPresentation(caught, "preview");
      setProviderHistory({ kind: "error", sessionId, ...presentation });
    }
  }, []);

  const reload = useCallback(async (importProvider = false, silent = false) => {
    if (!silent) setLoading(true);
    if (!silent) setError(null);
    try {
      if (importProvider) await api.importSessions();
      const [agentList, nextSessions, nextFlows, nextConsumableFlows, nextFlowCapabilities] = await Promise.all([
        api.agents(),
        api.sessions(false, true),
        api.flows("manage"),
        api.flows("consume"),
        api.flowCapabilities(),
      ]);
      const nextAgents = agentList.agents;
      setAgents(nextAgents);
      setDefaultAgentId(agentList.default_agent_id);
      setEffectiveDefaultAgentId(agentList.effective_default_agent_id);
      setSessions(nextSessions);
      setFlows(nextFlows);
      setConsumableFlows(nextConsumableFlows);
      setFlowCapabilities(nextFlowCapabilities);
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
  useEffect(() => {
    selectedSessionRef.current = selectedSessionId;
    providerHistoryRequestVersion.current += 1;
    pendingHistoryImportKey.current = null;
    providerHistoryPreview.current = null;
    setProviderHistory({ kind: "idle" });
  }, [selectedSessionId]);

  useEffect(() => {
    if (loading || deepLinkHandled.current) return;
    const params = new URLSearchParams(window.location.search);
    const flowId = params.get("flow");
    const batchId = params.get("batch");
    const sessionId = params.get("session");
    if (!flowId && !batchId && !sessionId) return;
    deepLinkHandled.current = true;
    queueMicrotask(() => {
      if (sessionId) {
        const session = sessions.find((candidate) => candidate.session_id === sessionId);
        if (!session) {
          notify("深链中的 Session 不存在或不可访问", "error");
          return;
        }
        setSelectedAgentId(session.agent_id);
        setSelectedSessionId(session.session_id);
      }
      if (flowId) {
        setArea("flows");
        void openFlow(flowId);
      }
      if (batchId) void openFlowBatch({ batchId });
    });
  }, [loading, notify, sessions]);

  useEffect(() => {
    if (!detailCandidateFlowId || !detailEvidenceKey) return;
    let active = true;
    void api.flowReviewContext(detailCandidateFlowId).then((context) => {
      if (!active) return;
      setFlowReviewContext(context);
      setDetailFlow(context.flow);
    }).catch(() => {});
    return () => { active = false; };
  }, [detailCandidateFlowId, detailEvidenceKey]);

  useEffect(() => {
    let active = true;
    if (!selectedSessionId || !waitingRuntimeApprovals.length) {
      queueMicrotask(() => {
        if (active) setApprovalStatusOverrides({});
      });
      return () => { active = false; };
    }
    const byRun = new Map<string, string[]>();
    for (const approval of waitingRuntimeApprovals) {
      byRun.set(approval.runId, [...(byRun.get(approval.runId) ?? []), approval.approvalId]);
    }
    void Promise.all(Array.from(byRun, async ([runId, approvalIds]) => {
      const records = await api.approvals(runId).catch(() => []);
      return records.filter((record) =>
        approvalIds.includes(record.id) && record.status === "expired"
      );
    })).then((groups) => {
      if (!active) return;
      setApprovalStatusOverrides(Object.fromEntries(
        groups.flat().map((record) => [record.id, "expired" as const]),
      ));
    });
    return () => { active = false; };
  }, [selectedSessionId, waitingRuntimeApprovals]);

  useEffect(() => {
    if (!activeFlowBatchId || !activeFlowBatchStatus || !["queued", "running"].includes(activeFlowBatchStatus)) return;
    let active = true;
    const timer = window.setInterval(() => {
      void api.flowBatch(activeFlowBatchId).then((snapshot) => {
        if (active) setFlowBatch(snapshot);
      }).catch((caught) => {
        if (active) setFlowBatchError(messageOf(caught));
      });
    }, 1500);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [activeFlowBatchId, activeFlowBatchStatus]);

  useEffect(() => {
    window.localStorage.setItem("codebridge:web-theme", theme);
    // The boot script in index.html primes <html data-theme> before first paint;
    // it must follow runtime switches too or <body>/scrollbars keep the old theme.
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!selectedSessionId) {
      sessionConnection.close();
      setCommands([]);
      setConfigOptions([]);
      setModel("");
      setEffort("");
      setConfigOverrides({});
      setPermissionMode("");
      setPendingFlowId("");
      setLoadingSession(false);
      setWorkspaceListing(null);
      return;
    }

    const sessionId = selectedSessionId;
    let active = true;
    setLoadingSession(!sessionViewStore.get(sessionId));
    setError(null);
    setMenuOpen(false);
    setMenuView("actions");
    setCommandOpen(false);
    setContextOpen(false);
    setWorkspaceListing(null);

    void (async () => {
      try {
        const snapshot = await api.openSession(sessionId);
        if (!active) return;
        sessionViewStore.hydrate(snapshot);
        const { session } = snapshot;
        setSessions((current) => current.map((value) => value.session_id === session.session_id ? session : value));
        setCommands(snapshot.commands);
        const [options, discovered] = await Promise.all([
          api.configOptions(sessionId),
          api.commands(sessionId).catch(() => snapshot.commands),
        ]);
        if (!active) return;
        setConfigOptions(options);
        setCommands(discovered);
        setModel(session.model ?? "");
        setEffort(session.effort ?? "");
        setConfigOverrides(session.config_overrides ?? {});
        setPermissionMode(session.permission_mode ?? "");
        setPendingFlowId("");
        setLoadingSession(false);
        if (session.provider_session_id) void previewProviderHistory(sessionId);
        await sessionConnection.open(sessionId);
      } catch (caught) {
        if (active) setError(messageOf(caught));
        if (active) setLoadingSession(false);
      }
    })();

    return () => {
      active = false;
      sessionConnection.close();
    };
  }, [previewProviderHistory, selectedSessionId, sessionConnection]);

  useEffect(() => {
    let active = true;
    if (!selectedSessionId) {
      queueMicrotask(() => {
        if (active) setFlowProposals([]);
        if (active) setFlowRecommendations([]);
      });
      return () => { active = false; };
    }
    const sessionId = selectedSessionId;
    void Promise.all([
      api.flowProposals(sessionId),
      api.flowRecommendations(sessionId),
    ]).then(([proposals, recommendations]) => {
      if (active) setFlowProposals(proposals);
      if (active) setFlowRecommendations(recommendations);
    }).catch(() => {
      if (active) setFlowProposals([]);
      if (active) setFlowRecommendations([]);
    });
    return () => { active = false; };
  }, [proposalRunKey, selectedSessionId]);

  const [stuckToBottom, setStuckToBottom] = useState(true);
  const sessionSwitch = useRef(true);
  const ignoreConversationScroll = useRef(false);

  useEffect(() => {
    sessionSwitch.current = true;
    setStuckToBottom(true);
  }, [selectedSessionId]);

  useEffect(() => {
    if (loadingSession || !selectedSessionId || !conversationViewport.current) return;
    if (!sessionSwitch.current && !stuckToBottom) return;
    const viewport = conversationViewport.current;
    const snapToLatest = () => {
      ignoreConversationScroll.current = true;
      viewport.scrollTop = viewport.scrollHeight;
      window.requestAnimationFrame(() => {
        ignoreConversationScroll.current = false;
      });
    };
    snapToLatest();
    const frame = window.requestAnimationFrame(() => {
      snapToLatest();
      if (sessionSwitch.current) {
        sessionSwitch.current = false;
        setStuckToBottom(true);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [sessionView, selectedSessionId, loadingSession, stuckToBottom]);

  function handleConversationScroll() {
    if (ignoreConversationScroll.current) return;
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

  async function importSelectedProviderHistory(): Promise<void> {
    const sessionId = selectedSessionRef.current;
    const preview = providerHistoryPreview.current;
    if (!sessionId || !preview) return;

    const requestVersion = ++providerHistoryRequestVersion.current;
    const pending = pendingHistoryImportKey.current;
    const key = pending?.sessionId === sessionId ? pending.key : crypto.randomUUID();
    pendingHistoryImportKey.current = { sessionId, key };
    setProviderHistory({ kind: "importing", sessionId, preview });

    let result;
    try {
      result = await api.importProviderHistory(sessionId, key);
    } catch (caught) {
      if (
        selectedSessionRef.current !== sessionId
        || providerHistoryRequestVersion.current !== requestVersion
      ) return;
      const presentation = providerHistoryErrorPresentation(caught, "import");
      if (presentation.code === "provider_history_cursor_conflict") {
        pendingHistoryImportKey.current = null;
        await previewProviderHistory(sessionId);
        return;
      }
      if (presentation.retry === null) pendingHistoryImportKey.current = null;
      setProviderHistory({ kind: "error", sessionId, ...presentation });
      if (presentation.code === "session_not_found") void reload(false, true);
      return;
    }

    if (
      selectedSessionRef.current !== sessionId
      || providerHistoryRequestVersion.current !== requestVersion
    ) return;
    pendingHistoryImportKey.current = null;

    try {
      const snapshot = await api.openSession(sessionId);
      if (
        selectedSessionRef.current !== sessionId
        || providerHistoryRequestVersion.current !== requestVersion
      ) return;
      sessionViewStore.hydrate(snapshot);
      setSessions((current) => current.map((item) =>
        item.session_id === snapshot.session.session_id ? snapshot.session : item
      ));
      setProviderHistory({ kind: "imported", sessionId, result });
    } catch {
      if (
        selectedSessionRef.current !== sessionId
        || providerHistoryRequestVersion.current !== requestVersion
      ) return;
      setProviderHistory({
        kind: "error",
        sessionId,
        code: "session_refresh_failed",
        message: "历史已导入，但刷新 Session 失败，请重新检查。",
        retry: "preview",
      });
    }
  }

  async function stopRun() {
    const runtime = sessionView?.snapshot.runtime;
    const activeRun = runtime?.active_run;
    if (!activeRun) return;
    try {
      const result = await api.cancelRun(activeRun.run_id, runtime.version, crypto.randomUUID());
      notify(result.disposition === "already_terminal" ? "当前 Run 已结束" : "已请求停止当前 Run");
      if (selectedSessionId) await sessionConnection.refresh(selectedSessionId);
    } catch (caught) {
      notify(messageOf(caught), "error");
    }
  }

  async function resolveRuntimeApproval(
    action: RuntimeApprovalAction,
    approve: boolean,
  ): Promise<void> {
    if (!selectedSessionId || resolvingApprovalId) return;
    setResolvingApprovalId(action.approvalId);
    try {
      if (approve) await api.approve(action.runId, action.approvalId);
      else await api.reject(action.runId, action.approvalId);
      setApprovalStatusOverrides((current) => {
        const next = { ...current };
        delete next[action.approvalId];
        return next;
      });
      await sessionConnection.refresh(selectedSessionId);
    } catch (caught) {
      await sessionConnection.refresh(selectedSessionId).catch(() => {});
      const records = await api.approvals(action.runId).catch(() => []);
      const current = records.find((record) => record.id === action.approvalId);
      if (current?.status === "expired") {
        setApprovalStatusOverrides((value) => ({
          ...value,
          [action.approvalId]: "expired",
        }));
      }
      notify(messageOf(caught), "error");
    } finally {
      setResolvingApprovalId(null);
    }
  }

  async function openFlow(id: string) {
    setMissingInputs([]);
    setFlowControlError(null);
    try {
      const context = await api.flowReviewContext(id);
      setFlowReviewContext(context);
      setDetailFlow(context.flow);
      setParamValues(defaultsFromFlow(context.flow));
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function refreshFlowCatalog(flowId?: string): Promise<FlowReviewContext | null> {
    const [nextFlows, nextConsumableFlows] = await Promise.all([
      api.flows("manage"),
      api.flows("consume"),
    ]);
    setFlows(nextFlows);
    setConsumableFlows(nextConsumableFlows);
    if (!flowId) return null;
    const context = await api.flowReviewContext(flowId);
    setFlowReviewContext(context);
    setDetailFlow(context.flow);
    setParamValues((current) => ({ ...defaultsFromFlow(context.flow), ...current }));
    return context;
  }

  async function createCandidateFromRun(runId: string): Promise<void> {
    if (!selectedSessionId || savingCandidateRunId) return;
    setSavingCandidateRunId(runId);
    setFlowControlError(null);
    try {
      const candidate = await api.createCandidate(selectedSessionId, runId);
      await refreshFlowCatalog(candidate.flow_id);
      notify(`已生成 Candidate · ${candidate.name || candidate.flow_id}`);
    } catch (caught) {
      notify(messageOf(caught), "error");
    } finally {
      setSavingCandidateRunId(null);
    }
  }

  async function createGuideFromRun(runId: string): Promise<void> {
    if (!selectedSessionId || savingGuideRunId) return;
    setSavingGuideRunId(runId);
    setFlowControlError(null);
    try {
      const guide = await api.saveGuide(selectedSessionId, runId);
      await refreshFlowCatalog(guide.flow_id);
      notify(`已整理为 Guide 草稿 · ${guide.name || guide.flow_id}`);
    } catch (caught) {
      notify(messageOf(caught), "error");
    } finally {
      setSavingGuideRunId(null);
    }
  }

  async function openFlowRecommendation(recommendation: FlowRecommendation): Promise<void> {
    try {
      const context = await api.flowReviewContext(recommendation.flow_id);
      if (context.flow.definition_revision !== recommendation.definition_revision) {
        notify("该 Flow 版本已变化，请重新确认最新版本", "error");
        return;
      }
      setFlowReviewContext(context);
      setDetailFlow(context.flow);
      setParamValues({
        ...defaultsFromFlow(context.flow),
        ...recommendation.extracted_inputs,
      });
      setMissingInputs([]);
      notify("已打开建议 Flow；请核对参数后明确运行");
    } catch (caught) {
      notify(messageOf(caught), "error");
    }
  }

  async function dismissFlowRecommendation(recommendation: FlowRecommendation): Promise<void> {
    if (!selectedSessionId) return;
    try {
      await api.dismissFlowRecommendation(
        selectedSessionId,
        recommendation.run_id,
        recommendation.flow_id,
      );
      setFlowRecommendations((current) => current.map((entry) =>
        entry.recommendation_id === recommendation.recommendation_id
          ? { ...entry, status: "dismissed" }
          : entry
      ));
    } catch (caught) {
      notify(messageOf(caught), "error");
    }
  }

  async function saveCandidate(flow: FlowRecord): Promise<void> {
    if (!selectedSessionId || flowControlBusy) {
      if (!selectedSessionId) setFlowControlError("请选择来源 Session 后再保存 Candidate");
      return;
    }
    setFlowControlBusy(true);
    setFlowControlError(null);
    try {
      const saved = await api.saveCandidate(selectedSessionId, flow);
      await refreshFlowCatalog(saved.flow_id);
      notify("Candidate 已保存；revision 已由服务端重新计算");
    } catch (caught) {
      setFlowControlError(messageOf(caught));
    } finally {
      setFlowControlBusy(false);
    }
  }

  async function createGuideDraft(): Promise<void> {
    if (flowControlBusy) return;
    setFlowControlBusy(true);
    setFlowControlError(null);
    try {
      const created = await api.createGuide({
        name: "未命名 Guide",
        description: "",
        steps: [{
          id: "step_1", capability: null, purpose: "请描述这个人工步骤", depends_on: [],
          mode: "manual", approval: "none", branches: [], retry: null, success_when: null,
        }],
      });
      await refreshFlowCatalog(created.flow_id);
      notify("Guide 草稿已创建；请整理名称和人工步骤");
    } catch (caught) {
      setFlowControlError(messageOf(caught));
    } finally {
      setFlowControlBusy(false);
    }
  }

  async function importGuideDraft(file: File): Promise<void> {
    if (flowControlBusy) return;
    setFlowControlBusy(true);
    setFlowControlError(null);
    try {
      const parsed = JSON.parse(await file.text()) as Record<string, unknown>;
      const source = parsed.flow && typeof parsed.flow === "object" && !Array.isArray(parsed.flow)
        ? parsed.flow as Record<string, unknown>
        : parsed;
      const created = await api.createGuide(source as unknown as Pick<FlowRecord, "name" | "description" | "steps">);
      await refreshFlowCatalog(created.flow_id);
      notify("Guide JSON 已导入；revision 已由服务端重新计算");
    } catch (caught) {
      setFlowControlError(messageOf(caught));
      notify(messageOf(caught), "error");
    } finally {
      setFlowControlBusy(false);
    }
  }

  async function saveGuideDraft(flow: FlowRecord): Promise<void> {
    if (flowControlBusy) return;
    setFlowControlBusy(true);
    setFlowControlError(null);
    try {
      const saved = await api.saveGuideDraft(flow);
      await refreshFlowCatalog(saved.flow_id);
      notify("Guide 草稿已保存；revision 已由服务端重新计算");
    } catch (caught) {
      setFlowControlError(messageOf(caught));
    } finally {
      setFlowControlBusy(false);
    }
  }

  async function reviewDefinition(decision: "approve" | "reject", gitRevision?: string): Promise<void> {
    if (!detailFlow || flowControlBusy) return;
    setFlowControlBusy(true);
    setFlowControlError(null);
    try {
      const reviewed = await api.reviewFlow(detailFlow.flow_id, decision, gitRevision);
      await refreshFlowCatalog(reviewed.flow_id);
      notify(decision === "approve" ? "Flow 已批准并发布" : "Candidate 已打回");
    } catch (caught) {
      setFlowControlError(messageOf(caught));
    } finally {
      setFlowControlBusy(false);
    }
  }

  async function deprecateDefinition(): Promise<void> {
    if (!detailFlow || flowControlBusy) return;
    setFlowControlBusy(true);
    setFlowControlError(null);
    try {
      const deprecated = await api.deprecateFlow(detailFlow.flow_id);
      await refreshFlowCatalog(deprecated.flow_id);
      notify("Flow 已废弃，历史证据仍保留");
    } catch (caught) {
      setFlowControlError(messageOf(caught));
    } finally {
      setFlowControlBusy(false);
    }
  }

  function captureFlowMismatch(error: {
    code: string;
    body: Record<string, unknown> | null;
  }): boolean {
    const body = error.body;
    if (
      error.code !== "flow_revision_mismatch"
      || body?.source !== "binding"
      || typeof body.flow_id !== "string"
      || typeof body.expected_definition_revision !== "string"
      || typeof body.current_definition_revision !== "string"
    ) {
      return false;
    }
    setFlowMismatch({
      source: "binding",
      flow_id: body.flow_id,
      expected_definition_revision: body.expected_definition_revision,
      current_definition_revision: body.current_definition_revision,
    });
    return true;
  }

  async function bindFlowToSession(flow: FlowRecord) {
    const sessionId = selectedSessionId ?? (await ensureSession());
    if (!sessionId) {
      setError("请选择一个可用的 Agent");
      return;
    }
    try {
      const binding = await api.applyFlow(sessionId, flow.flow_id);
      setSessions((current) => current.map((session) => session.session_id === sessionId
        ? {
            ...session,
            flow_id: binding.flow_id,
            flow_definition_revision: binding.definition_revision,
          }
        : session));
      setFlowMismatch(null);
      notify(`已绑定 ${flow.name || flow.flow_id}`);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function unbindSelectedFlow() {
    if (!selectedSessionId) return;
    try {
      const updated = await api.unbindFlow(selectedSessionId);
      setSessions((current) => current.map((session) => session.session_id === updated.session_id ? updated : session));
      setFlowMismatch(null);
      notify("已解绑 Flow");
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function rebindLatestFlow() {
    if (!selectedSessionId || !flowMismatch) return;
    try {
      const latest = await api.fetchFlow(flowMismatch.flow_id);
      if (latest.definition_revision !== flowMismatch.current_definition_revision) {
        setError("Flow 已再次更新，请重新查看最新版本");
        return;
      }
      setDetailFlow(latest);
      setParamValues(defaultsFromFlow(latest));
      await bindFlowToSession(latest);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function ensureSession(): Promise<string | null> {
    if (selectedSessionId) return selectedSessionId;
    if (!selectedAgent || selectedAgent.status !== "healthy") return null;
    return (await createSession(selectedAgent.agent_id))?.session_id ?? null;
  }

  async function runFlow(flow: FlowRecord, values: Record<string, unknown>, dryRun: boolean) {
    if (sending) return;
    setParamValues(values);
    setMissingInputs([]);
    setSending(true);
    setError(null);
    const message = flowRunMessage(draft, flow);
    const idempotencyKey = crypto.randomUUID();
    const sessionId = selectedSessionId ?? (await ensureSession());
    if (!sessionId) {
      setError("请选择一个可用的 Agent");
      setSending(false);
      return;
    }
    const result = await submitSessionMessage({
      send: api.sendMessage,
      lookup: api.submission,
      sessionId,
      idempotencyKey,
      input: {
        message,
        flowId: flow.flow_id,
        definitionRevision: flow.definition_revision,
        model: model || null,
        attachments,
        permissionMode: permissionMode || null,
        effort: effort || null,
        inputs: values,
        dryRun,
      },
    });
    if (result.kind === "rejected" && result.error.code === "missing_inputs" && Array.isArray(result.error.body?.missing)) {
      setMissingInputs(result.error.body.missing as Array<{ id: string; type: string; source: string; reason: string }>);
      setSending(false);
      return;
    }
    if (result.kind === "rejected" || result.kind === "unknown") {
      if (result.kind !== "rejected" || !captureFlowMismatch(result.error)) {
        setError(messageOf(result.kind === "rejected" ? result.error : result.idempotencyKey));
      }
      setSending(false);
      return;
    }
    await sessionConnection.refresh(sessionId).catch(() => {});
    setSending(false);
  }

  async function submit() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    const pendingAttachments = attachments;
    setDraft("");
    setAttachments([]);
    let sessionId = selectedSessionId;
    if (!sessionId) {
      if (!selectedAgent || selectedAgent.status !== "healthy") {
        setDraft(message);
        setAttachments(pendingAttachments);
        setError(selectedAgent
          ? `${selectedAgent.display_name} 当前不可用（${statusLabel[selectedAgent.status] ?? selectedAgent.status}），请先在设置中完成安装/配置`
          : "请选择一个可用的 Agent");
        setSending(false);
        return;
      }
      sessionId = (await createSession(selectedAgent.agent_id))?.session_id ?? null;
    }
    if (!sessionId) {
      setDraft(message);
      setAttachments(pendingAttachments);
      setSending(false);
      return;
    }
    const idempotencyKey = pendingSubmissionKey.current ?? crypto.randomUUID();
    pendingSubmissionKey.current = idempotencyKey;
    const result = await submitSessionMessage({
      send: api.sendMessage,
      lookup: api.submission,
      sessionId,
      idempotencyKey,
      input: {
        message,
        ...(pendingFlow
          ? {
              flowId: pendingFlow.flow_id,
              definitionRevision: pendingFlow.definition_revision,
            }
          : {}),
        model: model || null,
        attachments: pendingAttachments,
        permissionMode: permissionMode || null,
        effort: effort || null,
        inputs: pendingFlow ? paramValues : undefined,
      },
    });
    if (result.kind === "unknown") {
      setDraft(message);
      setAttachments(pendingAttachments);
      setError(`发送结果未知。重试时将使用请求 ${result.idempotencyKey}`);
      setSending(false);
      return;
    }
    if (result.kind === "rejected") {
      pendingSubmissionKey.current = null;
      setDraft(message);
      setAttachments(pendingAttachments);
      if (!captureFlowMismatch(result.error)) setError(messageOf(result.error));
      setSending(false);
      return;
    }
    pendingSubmissionKey.current = null;
    setPendingFlowId("");
    try {
      if (
        result.receipt.acceptance === "queued"
        && result.receipt.runtime.queue_state === "paused"
        && !result.receipt.runtime.active_run
      ) {
        await api.resumeQueue(sessionId, result.receipt.runtime.version, crypto.randomUUID());
      }
      await sessionConnection.refresh(sessionId);
      setSessions((current) => current.map((session) => session.session_id === sessionId
        ? { ...session, status: "active", title: session.title ?? message.slice(0, 60), updated_at: new Date().toISOString() }
        : session));
    } catch (caught) {
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

  async function addFiles(files: FileList | File[]) {
    const results = await Promise.allSettled(Array.from(files).map(readAttachment));
    const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    if (successful.length) setAttachments((current) => [...current, ...successful]);
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) setError(messageOf(failed.reason));
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
    setCommandOpen(nextTrigger?.kind === "command");
    // Opening the context popup via typing "@" must also load the listing;
    // previously only the toolbar "@" button fetched it, leaving an empty panel.
    const openContext = nextTrigger?.kind === "context" && workspacePaths(selectedSession).length > 0;
    setContextOpen(openContext);
    if (openContext && !workspaceListing && selectedSessionId) void browseWorkspace();
    setDraft(value);
  }

  async function loadEarlierTimeline() {
    if (!selectedSessionId || loadingEarlier) return;
    const before = sessionView?.snapshot.timeline.previous_cursor;
    if (before === null || before === undefined) return;
    setLoadingEarlier(true);
    try {
      sessionViewStore.mergeTimelinePage(selectedSessionId, await api.timeline(selectedSessionId, before));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoadingEarlier(false);
    }
  }

  async function loadBlockSegments(blockId: string, after: number) {
    if (!selectedSessionId || loadingBlockId) return;
    setLoadingBlockId(blockId);
    try {
      sessionViewStore.mergeSegmentPage(selectedSessionId, blockId, await api.segments(selectedSessionId, blockId, after));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoadingBlockId(null);
    }
  }

  async function cancelQueuedTurn(turnId: string, version: number) {
    if (!selectedSessionId || cancellingTurnId) return;
    setCancellingTurnId(turnId);
    try {
      await api.cancelQueuedTurn(selectedSessionId, turnId, version, crypto.randomUUID());
      await sessionConnection.refresh(selectedSessionId);
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setCancellingTurnId(null);
    }
  }

  async function resumeQueue(version: number) {
    if (!selectedSessionId) return;
    try {
      await api.resumeQueue(selectedSessionId, version, crypto.randomUUID());
      await sessionConnection.refresh(selectedSessionId);
    } catch (caught) {
      setError(messageOf(caught));
    }
  }

  async function loadMoreQueue() {
    if (!selectedSessionId || loadingQueue) return;
    const cursor = sessionView?.snapshot.runtime.queue.next_cursor;
    if (cursor === null || cursor === undefined) return;
    setLoadingQueue(true);
    try {
      sessionViewStore.mergeQueuePage(selectedSessionId, await api.queue(selectedSessionId, cursor));
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoadingQueue(false);
    }
  }

  async function openFlowBatch(reference: { draftId?: string; batchId?: string }) {
    setFlowBatchBusy(true);
    setFlowBatchError(null);
    try {
      if (reference.batchId) {
        const snapshot = await api.flowBatch(reference.batchId);
        setFlowBatch(snapshot);
        setFlowBatchDraft(null);
        const url = new URL(window.location.href);
        url.searchParams.set("batch", snapshot.batch_id);
        if (snapshot.session_id) url.searchParams.set("session", snapshot.session_id);
        window.history.replaceState(null, "", url);
      } else if (reference.draftId) {
        const nextDraft = await api.flowBatchDraft(reference.draftId);
        setFlowBatchDraft(nextDraft);
        setFlowBatch(null);
      }
    } catch (caught) {
      setFlowBatchError(messageOf(caught));
    } finally {
      setFlowBatchBusy(false);
    }
  }

  function closeFlowBatch() {
    setFlowBatchDraft(null);
    setFlowBatch(null);
    setFlowBatchError(null);
    const url = new URL(window.location.href);
    url.searchParams.delete("batch");
    window.history.replaceState(null, "", url);
  }

  async function saveFlowBatchDraft(next: FlowBatchDraft) {
    setFlowBatchBusy(true);
    setFlowBatchError(null);
    try {
      setFlowBatchDraft(await api.updateFlowBatchDraft(next));
      notify("批量参数已重新校验并保存");
    } catch (caught) {
      setFlowBatchError(messageOf(caught));
    } finally {
      setFlowBatchBusy(false);
    }
  }

  async function confirmFlowBatch(concurrency: number) {
    if (!flowBatchDraft) return;
    setFlowBatchBusy(true);
    setFlowBatchError(null);
    try {
      const snapshot = await api.confirmFlowBatchDraft(
        flowBatchDraft.draft_id,
        flowBatchDraft.revision,
        crypto.randomUUID(),
        concurrency,
      );
      setFlowBatchDraft(null);
      setFlowBatch(snapshot);
      notify(`已交给 Runtime 执行 ${snapshot.counts.total} 项`);
    } catch (caught) {
      setFlowBatchError(messageOf(caught));
    } finally {
      setFlowBatchBusy(false);
    }
  }

  async function cancelFlowBatchDraft() {
    if (!flowBatchDraft) return;
    setFlowBatchBusy(true);
    try {
      setFlowBatchDraft(await api.cancelFlowBatchDraft(flowBatchDraft.draft_id));
    } catch (caught) {
      setFlowBatchError(messageOf(caught));
    } finally {
      setFlowBatchBusy(false);
    }
  }

  async function cancelFlowBatch() {
    if (!flowBatch) return;
    setFlowBatchBusy(true);
    try {
      setFlowBatch(await api.cancelFlowBatch(flowBatch.batch_id));
    } catch (caught) {
      setFlowBatchError(messageOf(caught));
    } finally {
      setFlowBatchBusy(false);
    }
  }

  async function retryFailedFlowBatch() {
    if (!flowBatch) return;
    setFlowBatchBusy(true);
    try {
      setFlowBatch(await api.retryFailedFlowBatch(flowBatch.batch_id, crypto.randomUUID()));
    } catch (caught) {
      setFlowBatchError(messageOf(caught));
    } finally {
      setFlowBatchBusy(false);
    }
  }

  const flowBatchSurface = flowBatchDraft || flowBatch ? <FlowBatchPanel
    batch={flowBatch}
    busy={flowBatchBusy}
    draft={flowBatchDraft}
    error={flowBatchError}
    key={flowBatchDraft ? `${flowBatchDraft.draft_id}:${flowBatchDraft.revision}` : flowBatch?.batch_id}
    onCancelBatch={() => { void cancelFlowBatch(); }}
    onCancelDraft={() => { void cancelFlowBatchDraft(); }}
    onClose={closeFlowBatch}
    onConfirm={(concurrency) => { void confirmFlowBatch(concurrency); }}
    onOpenRun={(runId) => {
      void navigator.clipboard?.writeText(runId);
      notify(`Run ${runId} 已复制，可在运行日志中定位`);
    }}
    onRetryFailed={() => { void retryFailedFlowBatch(); }}
    onSave={(next) => { void saveFlowBatchDraft(next); }}
  /> : null;

  const flowDetailSurface = detailFlow ? <div className="mb-4"><FlowDetail
    flow={detailFlow}
    management={flowReviewContext?.flow.flow_id === detailFlow.flow_id ? <FlowControlPanel
      busy={flowControlBusy}
      capabilities={flowCapabilities}
      context={flowReviewContext}
      error={flowControlError}
      key={`${flowReviewContext.flow.flow_id}:${flowReviewContext.flow.definition_revision}:${flowReviewContext.flow.status}`}
      onDeprecate={() => { void deprecateDefinition(); }}
      onReview={(decision, gitRevision) => { void reviewDefinition(decision, gitRevision); }}
      onSave={(flow) => { void (flow.kind === "guide" ? saveGuideDraft(flow) : saveCandidate(flow)); }}
    /> : undefined}
    missing={missingInputs}
    onBind={(flow) => { void bindFlowToSession(flow); }}
    onClose={() => { setDetailFlow(null); setFlowReviewContext(null); setFlowControlError(null); setMissingInputs([]); }}
    onSubmit={(values, dryRun) => { void runFlow(detailFlow, values, dryRun); }}
    onValues={(values) => {
      setParamValues(values);
      setMissingInputs((current) => current.filter((entry) => {
        const value = values[entry.id];
        return value === undefined || value === null || value === "";
      }));
    }}
    values={paramValues}
  /></div> : null;

  const selectedProviderHistory = providerHistory.kind !== "idle"
    && providerHistory.sessionId === selectedSessionId
    ? providerHistory
    : null;
  const providerHistorySurface = selectedProviderHistory ? <ProviderHistoryImportCard
    onImport={() => { void importSelectedProviderHistory(); }}
    onRetryImport={() => { void importSelectedProviderHistory(); }}
    onRetryPreview={() => {
      const sessionId = selectedSessionRef.current;
      if (sessionId) void previewProviderHistory(sessionId);
    }}
    state={selectedProviderHistory}
  /> : null;
  const hasTimeline = Boolean(sessionView?.snapshot.timeline.turns.length);
  const showProviderHistoryAboveTimeline = hasTimeline && selectedProviderHistory != null
    && ["available", "importing", "error", "imported"].includes(selectedProviderHistory.kind);

  return (
    <div className={cn("grid h-[100dvh] min-h-[100dvh] overflow-hidden font-sans text-sm tracking-[-0.01em]", panelOpen && (area === "agents" || area === "flows") ? "grid-cols-[60px_minmax(0,1fr)] md:grid-cols-[60px_286px_minmax(0,1fr)]" : "grid-cols-[60px_minmax(0,1fr)]", "bg-canvas text-ink")} data-density={density} data-reading={reading ? "serif" : "sans"} data-theme={theme}>
      <AgentRail
        agents={agents}
        area={area}
        selectedAgentId={selectedAgentId}
        theme={theme}
        onAgent={selectAgent}
        onArea={setArea}
        onTheme={toggleTheme}
      />

      {panelOpen && (area === "agents" || area === "flows") && <div className="hidden min-h-0 min-w-0 md:contents"><SessionPanel
        agent={selectedAgent}
        activeSessionCount={activeSessionCount}
        area={area}
        archivedSessionCount={archivedSessionCount}
        flows={flows}
        flowId={detailFlow?.flow_id ?? ""}
        loading={loading}
        query={query}
        sessions={agentSessions}
        selectedSessionId={selectedSessionId}
        onCreate={() => selectedAgent && void createSession(selectedAgent.agent_id)}
        onCreateGuide={() => { void createGuideDraft(); }}
        onImportGuide={() => guideImportInput.current?.click()}
        onFlow={(id) => { void openFlow(id); }}
        onQuery={setQuery}
        onRefresh={() => void reload(true)}
        onSession={selectSession}
        onUpdateSession={(session, update) => applySessionUpdate(session.session_id, update)}
        onDeleteSession={(session) => deleteSessionById(session.session_id)}
        onToggleArchived={() => setShowArchived((current) => !current)}
        showArchived={showArchived}
      /></div>}

      <input
        accept="application/json,.json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void importGuideDraft(file);
          event.currentTarget.value = "";
        }}
        ref={guideImportInput}
        type="file"
      />

      <main className={cn("relative flex min-h-0 min-w-0 flex-col overflow-hidden", "bg-canvas text-ink")}>
        {pixelWipe > 0 && <PixelWipe key={pixelWipe} seed={pixelWipe} />}
        {(area === "agents" || area === "flows") && <SessionHeader
          agent={selectedAgent}
          session={selectedSession}
          runState={runState}
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
        {flowMismatch && <div className={cn("mx-8 mt-4 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2.5 text-xs", "bg-warning-soft", "text-warning", "border-line-strong")} role="alert">
          <span className="min-w-0 flex-1">Flow 已更新，请确认后重新绑定</span>
          <button className="rounded border border-line px-2 py-1" onClick={() => void openFlow(flowMismatch.flow_id)} type="button">查看最新版本</button>
          <button className="rounded border border-line px-2 py-1" onClick={() => void rebindLatestFlow()} type="button">重新绑定</button>
          <button className="rounded border border-line px-2 py-1" onClick={() => void unbindSelectedFlow()} type="button">解绑</button>
        </div>}

        {area === "skills" ? (
          <SkillControlPlanePage onNotify={notify} />
        ) : area === "settings" ? (
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
        ) : !selectedSession && detailFlow ? (
          <section aria-label="Flow 管理" className="min-h-0 flex-1 overflow-y-auto px-8 py-7">
            <div className="mx-auto w-full max-w-[880px]">{flowDetailSurface}</div>
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
                flowId={pendingFlowId}
                flows={consumableFlows}
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
                onFlow={setPendingFlowId}
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
                {selectedSession.flow_id && <div className="mb-3 flex items-center gap-2 rounded-md border border-line bg-surface-soft px-3 py-2 text-xs text-muted">
                  <span className="min-w-0 flex-1 truncate">已绑定 Flow · {selectedSession.flow_id}</span>
                  <button className="text-ink hover:opacity-80" onClick={() => void unbindSelectedFlow()} type="button">解绑</button>
                </div>}
                {flowBatchSurface}
                {flowDetailSurface}
                {!loadingSession && showProviderHistoryAboveTimeline && <div className="mb-5">{providerHistorySurface}</div>}
                {loadingSession ? <LoadingConversation /> : sessionView && hasTimeline ? (
                  <SessionTimeline
                    activeRunId={sessionView.snapshot.runtime.active_run?.run_id ?? null}
                    approvalStatusOverrides={approvalStatusOverrides}
                    hasEarlier={sessionView.snapshot.timeline.previous_cursor !== null}
                    key={selectedSessionId}
                    loadingBlockId={loadingBlockId}
                    loadingEarlier={loadingEarlier}
                    onLoadEarlier={() => void loadEarlierTimeline()}
                    onLoadSegments={(blockId, after) => void loadBlockSegments(blockId, after)}
                    onCreateCandidate={(runId) => { void createCandidateFromRun(runId); }}
                    flowProposals={flowProposals}
                    flowRecommendations={flowRecommendations}
                    onCreateGuide={(runId) => { void createGuideFromRun(runId); }}
                    onUseFlowRecommendation={(recommendation) => { void openFlowRecommendation(recommendation); }}
                    onDismissFlowRecommendation={(recommendation) => { void dismissFlowRecommendation(recommendation); }}
                    onOpenFlowBatch={(reference) => { void openFlowBatch(reference); }}
                    onResolveApproval={(action, approve) => void resolveRuntimeApproval(action, approve)}
                    resolvingApprovalId={resolvingApprovalId}
                    savingCandidateRunId={savingCandidateRunId}
                    savingGuideRunId={savingGuideRunId}
                    solidifiableFlowIds={flows
                      .filter((flow) => flow.kind === "runbook" && flow.status === "published")
                      .map((flow) => flow.flow_id)}
                    turns={sessionView.snapshot.timeline.turns}
                  />
                ) : providerHistorySurface ? <div className="flex min-h-[42vh] items-center justify-center">
                  <div className="w-full max-w-[680px]">{providerHistorySurface}</div>
                </div> : <div aria-label="Empty Session" className="flex min-h-[42vh] flex-col items-center justify-center text-center">
                  <div className={cn("mb-4 grid size-10 place-items-center rounded-md border", "bg-accent", "text-accent-ink", "border-line-strong")}>{selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id} className="size-[18px]" /> : <PixelMark className="size-5" />}</div>
                  <h2 className={cn("font-brand text-xl font-normal tracking-[-0.02em]", "text-ink")}>{selectedSession.title || (selectedAgent ? `${selectedAgent.display_name} Session` : "Session")}</h2>
                  <p className={cn("mt-2 text-xs", "text-muted")}>输入目标开始当前 Session</p>
                </div>}
              </div>
            </section>
            {!stuckToBottom && <button aria-label="回到底部" className={cn("absolute bottom-32 left-1/2 z-20 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border px-3 text-xs shadow-panel transition-opacity", "bg-surface", "text-ink-soft", "border-line-strong")} onClick={() => { const viewport = conversationViewport.current; if (viewport) viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" }); }} type="button"><ChevronDown className="size-3.5" />回到最新</button>}
            <footer className="px-8 pb-5 pt-3">
              <div className="mx-auto grid min-w-0 w-full max-w-[880px] gap-3">
                {sessionView && <SessionQueue
                  cancellingTurnId={cancellingTurnId}
                  loadingMore={loadingQueue}
                  onCancel={(turnId, version) => void cancelQueuedTurn(turnId, version)}
                  onLoadMore={() => void loadMoreQueue()}
                  onResume={(version) => void resumeQueue(version)}
                  runtime={sessionView.snapshot.runtime}
                  turns={sessionView.snapshot.runtime.queue.turns}
                />}
                <Composer
                  attachments={attachments}
                  commands={commands}
                  contextOpen={contextOpen}
                  workspaceListing={workspaceListing}
                  workspaceLoading={workspaceLoading}
                  disabled={false}
                  draft={draft}
                  flowId={pendingFlowId}
                  flows={consumableFlows}
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
                  onFlow={setPendingFlowId}
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
