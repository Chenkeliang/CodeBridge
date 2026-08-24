import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Check,
  FolderPlus,
  Link2,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { BrandAgentIcon } from "@/components/brand-agent-icon";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { api } from "@/lib/api";
import type {
  SkillAgentId,
  SkillAssignmentInput,
  SkillAssignmentPreview,
  SkillCatalogEntry,
  SkillCatalogSnapshot,
  SkillProjectionState,
  SkillSourceKind,
} from "@/lib/types";
import { cn } from "@/lib/utils";

type SkillTab = "catalog" | "assignment" | "reconcile" | "activity";
type ActivityEntry = { id: string; label: string; detail: string; kind: "ok" | "error" };

const SOURCE_LABELS: Record<SkillSourceKind, string> = {
  shared: "共享主目录",
  adopted: "已登记目录",
  agent_native: "Agent 原生",
};

const STATE_LABELS: Record<SkillProjectionState, string> = {
  linked: "目录可见",
  absent: "未分发",
  conflict: "目标冲突",
  broken: "软链断开",
  native: "原生管理",
};

export function SkillControlPlanePage({ onNotify }: {
  onNotify: (message: string, kind?: "info" | "error") => void;
}) {
  const [snapshot, setSnapshot] = useState<SkillCatalogSnapshot | null>(null);
  const [tab, setTab] = useState<SkillTab>("catalog");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"all" | SkillSourceKind>("all");
  const [state, setState] = useState<"all" | "healthy" | "issue">("all");
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SkillCatalogEntry | null>(null);
  const [preview, setPreview] = useState<SkillAssignmentPreview | null>(null);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      setSnapshot(await api.skills());
    } catch (caught) {
      setError(messageOf(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return (snapshot?.skills ?? []).filter((skill) => {
      if (source !== "all" && skill.source_kind !== source) return false;
      const hasIssue = skill.targets.some((target) => target.state === "conflict" || target.state === "broken");
      if (state === "healthy" && hasIssue) return false;
      if (state === "issue" && !hasIssue) return false;
      if (!normalized) return true;
      return [skill.name, skill.description ?? "", skill.source_path, ...skill.tags]
        .join(" ").toLowerCase().includes(normalized);
    });
  }, [query, snapshot, source, state]);

  const issues = useMemo(() => (snapshot?.skills ?? []).flatMap((skill) =>
    skill.targets
      .filter((target) => target.state === "conflict" || target.state === "broken")
      .map((target) => ({ skill, target })),
  ), [snapshot]);

  function record(label: string, detail: string, kind: ActivityEntry["kind"] = "ok") {
    setActivities((current) => [
      { id: crypto.randomUUID(), label, detail, kind },
      ...current,
    ].slice(0, 20));
  }

  async function addSource() {
    setAdding(true);
    setError(null);
    try {
      const result = await api.pickSkillSource();
      if ("cancelled" in result) return;
      setSnapshot(result);
      record("Source 已登记", "Runner 已重新扫描本机 Skill 目录");
      onNotify("Skill Source 已登记");
    } catch (caught) {
      const message = messageOf(caught);
      setError(message);
      record("Source 登记失败", message, "error");
      onNotify(message, "error");
    } finally {
      setAdding(false);
    }
  }

  async function requestPreview(skill: SkillCatalogEntry, agentId: SkillAgentId, enabled: boolean) {
    const key = `${skill.id}:${agentId}`;
    setPreviewing(key);
    setError(null);
    try {
      setPreview(await api.previewSkillAssignment({
        skill_id: skill.id,
        agent_id: agentId,
        enabled,
      }));
    } catch (caught) {
      const message = messageOf(caught);
      setError(message);
      onNotify(message, "error");
    } finally {
      setPreviewing(null);
    }
  }

  async function applyAssignment() {
    if (!preview) return;
    const input: SkillAssignmentInput = {
      skill_id: preview.skill_id,
      agent_id: preview.agent_id,
      enabled: preview.enabled,
    };
    setApplying(true);
    setError(null);
    try {
      const result = await api.applySkillAssignment(input);
      record(
        result.enabled ? "Skill 已分发" : "Skill 分发已移除",
        `${result.skill_name} → ${agentName(snapshot, result.agent_id)}`,
      );
      setPreview(null);
      await load(true);
      onNotify(result.enabled ? "Skill 目录投影已创建" : "Skill 目录投影已移除");
    } catch (caught) {
      const message = messageOf(caught);
      setError(message);
      record("分发失败", message, "error");
      onNotify(message, "error");
    } finally {
      setApplying(false);
    }
  }

  return <section aria-label="Skill 管理" className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <header className={cn("flex min-h-[72px] shrink-0 items-center justify-between gap-4 border-b px-8", "border-line")}>
      <div className="min-w-0">
        <p className={cn("font-brand text-xs uppercase tracking-[0.1em]", "text-muted")}>Skills / 本机能力资产</p>
        <h1 className={cn("mt-1 truncate font-brand text-lg font-normal tracking-[-0.035em]", "text-ink")}>Skill 管理</h1>
      </div>
      <div className="flex shrink-0 gap-2">
        <button aria-label="重新扫描 Skill" className={actionClass(false)} disabled={loading} onClick={() => void load()} title="重新扫描 Skill" type="button">
          <RefreshCw className={cn("size-4", loading && "animate-spin")} /><span className="hidden sm:inline">重新扫描</span>
        </button>
        <button aria-label="添加 Skill" className={actionClass(true)} disabled={adding} onClick={() => void addSource()} title="添加本机 Skill Source" type="button">
          {adding ? <LoaderCircle className="size-4 animate-spin" /> : <FolderPlus className="size-4" />}<span className="hidden sm:inline">添加 Skill</span>
        </button>
      </div>
    </header>

    <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-8 py-6 max-md:px-4 max-md:py-4">
      {error && <div className={cn("mb-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs", "bg-danger-soft text-danger border-line-strong")} role="alert"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span><button aria-label="关闭错误" onClick={() => setError(null)} type="button"><X className="size-3.5" /></button></div>}

      <div className={cn("mb-5 grid grid-cols-4 overflow-hidden rounded-md border max-lg:grid-cols-2 max-sm:grid-cols-1", "border-line")}>
        <Metric label="技能目录" note={`${snapshot?.summary.sources ?? 0} 类来源`} value={snapshot?.summary.total ?? 0} />
        <Metric label="目录投影" note="含 Agent 原生目录" value={snapshot?.summary.linked ?? 0} />
        <Metric label="目标 Agent" note="Runner Adapter" value={snapshot?.targets.length ?? 0} />
        <Metric label="需要处理" note="冲突与断链" tone="warning" value={snapshot?.summary.issues ?? 0} />
      </div>

      <nav aria-label="Skill 管理视图" className={cn("mb-4 flex h-10 gap-6 overflow-x-auto border-b", "border-line")}>
        {([
          ["catalog", "技能目录"],
          ["assignment", "Agent 分发"],
          ["reconcile", "软链对账"],
          ["activity", "活动记录"],
        ] as Array<[SkillTab, string]>).map(([id, label]) => <button aria-pressed={tab === id} className={cn("h-10 shrink-0 border-b-2 border-transparent px-0.5 font-brand text-xs", "text-muted", tab === id && "border-accent text-accent")} key={id} onClick={() => setTab(id)} type="button">{label}</button>)}
      </nav>

      {tab === "catalog" && <CatalogView
        filtered={filtered}
        loading={loading}
        query={query}
        source={source}
        state={state}
        total={snapshot?.skills.length ?? 0}
        onQuery={setQuery}
        onSelect={setSelected}
        onSource={setSource}
        onState={setState}
      />}

      {tab === "assignment" && <AssignmentView
        previewing={previewing}
        snapshot={snapshot}
        onPreview={(skill, agentId, enabled) => void requestPreview(skill, agentId, enabled)}
      />}

      {tab === "reconcile" && <ReconcileView issues={issues} />}
      {tab === "activity" && <ActivityView activities={activities} scannedAt={snapshot?.scanned_at ?? null} />}
    </div>

    {selected && <SkillDrawer skill={selected} onClose={() => setSelected(null)} />}
    {preview && <PreviewDialog applying={applying} preview={preview} onApply={() => void applyAssignment()} onClose={() => setPreview(null)} />}
  </section>;
}

function Metric({ label, value, note, tone }: { label: string; value: number; note: string; tone?: "warning" }) {
  return <div className={cn("min-w-0 border-r p-4 last:border-r-0 max-lg:[&:nth-child(2)]:border-r-0 max-sm:border-b max-sm:border-r-0 max-sm:last:border-b-0", "bg-surface border-line")}>
    <div className={cn("text-xs", "text-muted")}>{label}</div>
    <div className="mt-1 flex min-w-0 items-baseline gap-2"><span className={cn("font-mono text-2xl", tone === "warning" ? "text-warning" : "text-ink")}>{value}</span><span className={cn("truncate text-[11px]", "text-faint")}>{note}</span></div>
  </div>;
}

function CatalogView({ filtered, loading, query, source, state, total, onQuery, onSelect, onSource, onState }: {
  filtered: SkillCatalogEntry[];
  loading: boolean;
  query: string;
  source: "all" | SkillSourceKind;
  state: "all" | "healthy" | "issue";
  total: number;
  onQuery: (value: string) => void;
  onSelect: (skill: SkillCatalogEntry) => void;
  onSource: (value: "all" | SkillSourceKind) => void;
  onState: (value: "all" | "healthy" | "issue") => void;
}) {
  return <>
    <div className="mb-4 grid min-w-0 grid-cols-[minmax(220px,360px)_132px_132px_minmax(0,1fr)] gap-2 max-lg:grid-cols-[minmax(160px,1fr)_120px_120px] max-sm:grid-cols-[minmax(0,1fr)_44px_44px]">
      <label className={cn("flex h-9 min-w-0 items-center gap-2 rounded-md border px-3", "bg-surface border-line")}><Search className={cn("size-3.5 shrink-0", "text-faint")} /><input aria-label="搜索 Skill" className={cn("min-w-0 flex-1 bg-transparent text-xs outline-none", "text-ink placeholder:text-faint")} onChange={(event) => onQuery(event.target.value)} placeholder="搜索名称、说明、标签或来源" value={query} /></label>
      <FilterSelect
        label="筛选 Skill 来源"
        options={[["all", "全部来源"], ["shared", "共享主目录"], ["adopted", "已登记目录"], ["agent_native", "Agent 原生"]]}
        value={source}
        onValue={(value) => onSource(value as "all" | SkillSourceKind)}
      />
      <FilterSelect
        label="筛选 Skill 状态"
        options={[["all", "全部状态"], ["healthy", "正常"], ["issue", "需处理"]]}
        value={state}
        onValue={(value) => onState(value as "all" | "healthy" | "issue")}
      />
      <div className={cn("self-center truncate text-right text-xs max-lg:hidden", "text-faint")}>显示 {filtered.length} / {total} 个 Skill</div>
    </div>
    {loading && !filtered.length ? <div className={cn("grid min-h-48 place-items-center rounded-md border", "bg-surface border-line text-muted")}><LoaderCircle className="size-5 animate-spin" /></div> : filtered.length ? <div className="grid grid-cols-3 gap-3 max-xl:grid-cols-2 max-md:grid-cols-1">{filtered.map((skill) => <SkillCard key={skill.id} onSelect={onSelect} skill={skill} />)}</div> : <div className={cn("grid min-h-48 place-items-center rounded-md border border-dashed text-xs", "border-line-strong text-muted")}>没有匹配的 Skill</div>}
  </>;
}

function SkillCard({ skill, onSelect }: { skill: SkillCatalogEntry; onSelect: (skill: SkillCatalogEntry) => void }) {
  const issueCount = skill.targets.filter((target) => target.state === "conflict" || target.state === "broken").length;
  const visibleCount = skill.targets.filter((target) => target.state === "linked" || target.state === "native").length;
  return <button className={cn("group flex min-h-48 min-w-0 flex-col rounded-md border p-4 text-left transition-all hover:-translate-y-px hover:opacity-90", "bg-surface border-line hover:border-line-strong")} onClick={() => onSelect(skill)} type="button">
    <div className="flex min-w-0 items-start gap-3"><span className={cn("grid size-9 shrink-0 place-items-center rounded-md border", "bg-surface-soft border-line-strong text-muted")}><BookOpen className="size-4" /></span><div className="min-w-0 flex-1"><h2 className={cn("truncate text-sm font-semibold", "text-ink")}>{skill.name}</h2><p className={cn("mt-0.5 truncate font-mono text-[10px]", "text-faint")}>{SOURCE_LABELS[skill.source_kind]} · {shortPath(skill.source_path)}</p></div><StatePill issue={issueCount > 0} label={issueCount ? `${issueCount} 项异常` : "正常"} /></div>
    <p className={cn("my-4 line-clamp-2 min-h-10 text-xs leading-5", "text-muted")}>{skill.description || "未提供说明"}</p>
    <div className="flex flex-wrap gap-1.5">{skill.tags.slice(0, 4).map((tag) => <span className={cn("rounded border px-1.5 py-0.5 font-mono text-[9px]", "bg-canvas border-line text-faint")} key={tag}>{tag}</span>)}</div>
    <div className={cn("mt-auto flex items-center justify-between border-t pt-3 text-[10px]", "border-line text-faint")}><span className="font-mono">{skill.revision.slice(0, 8)}</span><span>{visibleCount} / {skill.targets.length} 个目标可见</span></div>
  </button>;
}

function AssignmentView({ snapshot, previewing, onPreview }: {
  snapshot: SkillCatalogSnapshot | null;
  previewing: string | null;
  onPreview: (skill: SkillCatalogEntry, agentId: SkillAgentId, enabled: boolean) => void;
}) {
  return <>
    <div className={cn("mb-3 flex items-start gap-2 border-l-2 px-3 py-2.5 text-xs leading-5", "bg-surface border-accent text-muted")}><Link2 className="mt-0.5 size-3.5 shrink-0 text-accent" /><span><strong className="text-ink">开关只管理软链投影。</strong>每次修改先展示 Source、Target 和动作；“目录可见”不等于正在运行的 Agent 已热加载。</span></div>
    <div className={cn("w-full max-w-full overflow-x-auto overflow-y-hidden rounded-md border", "border-line")}>
      <table className="w-full min-w-[1080px] table-fixed border-collapse">
        <thead><tr>{["Skill", ...(snapshot?.targets.map((target) => target.display_name) ?? [])].map((label, index) => <th className={cn("h-12 border-b border-r px-3 text-left text-[10px] last:border-r-0", "bg-surface-tint border-line text-muted", index === 0 && "sticky left-0 z-10 w-[250px]")} key={label}>{label}</th>)}</tr></thead>
        <tbody>{snapshot?.skills.map((skill) => <tr key={skill.id}><td className={cn("sticky left-0 z-10 h-[68px] w-[250px] border-b border-r px-3", "bg-surface border-line")}><div className="flex min-w-0 items-center gap-2"><span className={cn("grid size-8 shrink-0 place-items-center rounded-md border", "bg-surface-soft border-line text-muted")}><BookOpen className="size-3.5" /></span><div className="min-w-0"><div className="truncate text-xs font-medium">{skill.name}</div><div className={cn("truncate font-mono text-[9px]", "text-faint")}>{skill.revision.slice(0, 8)}</div></div></div></td>{snapshot.targets.map((definition) => {
          const target = skill.targets.find((candidate) => candidate.agent_id === definition.agent_id)!;
          const enabled = target.state === "linked" || target.state === "native";
          const immutable = target.state === "native";
          const key = `${skill.id}:${definition.agent_id}`;
          return <td className={cn("h-[68px] border-b border-r px-3 last:border-r-0", "bg-surface border-line")} key={definition.agent_id}><div className="flex items-center justify-between gap-2"><div className="min-w-0"><div className={cn("truncate text-[11px]", stateTone(target.state))}>{STATE_LABELS[target.state]}</div><div className={cn("truncate text-[9px]", "text-faint")}>{immutable ? "只读观察" : target.state === "linked" ? "SKILL.md 可读" : target.state === "absent" ? "不写入目录" : target.detail}</div></div><button aria-label={`${enabled ? "移除" : "分发"} ${skill.name} ${enabled ? "从" : "到"} ${definition.display_name}`} aria-pressed={enabled} className={cn("relative h-[18px] w-[30px] shrink-0 rounded-full border", enabled ? "border-accent/50 bg-accent/20" : "bg-surface-soft border-line-strong", immutable && "cursor-not-allowed opacity-50")} disabled={immutable || previewing === key} onClick={() => onPreview(skill, definition.agent_id, !enabled)} type="button"><span className={cn("absolute top-[3px] size-[10px] rounded-full transition-transform", enabled ? "left-[15px] bg-accent" : "left-[3px] bg-faint")} /></button></div></td>;
        })}</tr>)}</tbody>
      </table>
    </div>
  </>;
}

function ReconcileView({ issues }: { issues: Array<{ skill: SkillCatalogEntry; target: SkillCatalogEntry["targets"][number] }> }) {
  if (!issues.length) return <div className={cn("grid min-h-48 place-items-center rounded-md border text-xs", "bg-surface border-line text-muted")}><div className="flex items-center gap-2"><Check className="size-4 text-success" />当前没有软链冲突或断链</div></div>;
  return <div className={cn("overflow-hidden rounded-md border", "bg-surface border-line")}>{issues.map(({ skill, target }) => <div className={cn("grid min-w-0 grid-cols-[minmax(160px,1fr)_minmax(220px,1.6fr)_110px] items-center gap-4 border-b px-4 py-3 last:border-b-0 max-md:grid-cols-[minmax(0,1fr)_100px]", "border-line")} key={`${skill.id}:${target.agent_id}`}><div className="min-w-0"><div className="truncate text-xs font-medium">{skill.name} → {target.agent_id}</div><div className={cn("mt-0.5 truncate text-[10px]", "text-faint")}>{target.detail}</div></div><div className={cn("truncate font-mono text-[10px] max-md:hidden", "text-muted")}>{target.target_path}</div><div className={cn("flex items-center gap-1.5 text-[11px]", stateTone(target.state))}><AlertTriangle className="size-3.5" />{STATE_LABELS[target.state]}</div></div>)}</div>;
}

function ActivityView({ activities, scannedAt }: { activities: ActivityEntry[]; scannedAt: string | null }) {
  const rows = activities.length ? activities : [{ id: "scan", label: "目录扫描完成", detail: scannedAt ? new Date(scannedAt).toLocaleString() : "等待首次扫描", kind: "ok" as const }];
  return <div className={cn("overflow-hidden rounded-md border", "bg-surface border-line")}>{rows.map((activity) => <div className={cn("flex items-center gap-3 border-b px-4 py-3 last:border-b-0", "border-line")} key={activity.id}><span className={cn("grid size-7 shrink-0 place-items-center rounded-full", activity.kind === "ok" ? "bg-success/10 text-success" : "bg-danger-soft text-danger")}>{activity.kind === "ok" ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}</span><div className="min-w-0"><div className="text-xs font-medium">{activity.label}</div><div className={cn("mt-0.5 truncate text-[10px]", "text-faint")}>{activity.detail}</div></div></div>)}</div>;
}

function SkillDrawer({ skill, onClose }: { skill: SkillCatalogEntry; onClose: () => void }) {
  return <div className="fixed inset-y-0 left-[60px] right-0 z-40 bg-black/60" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><aside className={cn("ml-auto flex h-full w-[min(450px,calc(100vw-60px))] flex-col border-l", "bg-surface border-line-strong")}>
    <header className={cn("flex min-h-[72px] items-center justify-between border-b px-5", "border-line")}><h2 className="font-brand text-sm">Skill 详情</h2><button aria-label="关闭 Skill 详情" className={iconButtonClass()} onClick={onClose} type="button"><X className="size-4" /></button></header>
    <div className="min-h-0 flex-1 overflow-y-auto p-5"><div className="flex items-center gap-3"><span className={cn("grid size-11 place-items-center rounded-md border", "bg-surface-soft border-line-strong text-muted")}><BookOpen className="size-5" /></span><div className="min-w-0"><h3 className="truncate text-base font-semibold">{skill.name}</h3><p className={cn("truncate font-mono text-[10px]", "text-faint")}>{SOURCE_LABELS[skill.source_kind]}</p></div></div><p className={cn("my-5 text-xs leading-6", "text-muted")}>{skill.description || "未提供说明"}</p><DetailSection title="包信息"><Fact label="Source" value={skill.source_path} mono /><Fact label="Revision" value={skill.revision} mono /><Fact label="更新时间" value={new Date(skill.updated_at).toLocaleString()} /></DetailSection><DetailSection title="Agent 目录状态">{skill.targets.map((target) => <div className="flex items-center justify-between gap-3 py-2" key={target.agent_id}><div className="flex min-w-0 items-center gap-2"><span className={cn("grid size-6 shrink-0 place-items-center rounded border", "border-line text-muted")}><BrandAgentIcon agentId={target.agent_id} className="size-3" /></span><div className="min-w-0"><div className="text-xs">{target.agent_id}</div><div className={cn("truncate font-mono text-[9px]", "text-faint")}>{target.target_path}</div></div></div><span className={cn("shrink-0 text-[10px]", stateTone(target.state))}>{STATE_LABELS[target.state]}</span></div>)}</DetailSection></div>
  </aside></div>;
}

function PreviewDialog({ preview, applying, onApply, onClose }: { preview: SkillAssignmentPreview; applying: boolean; onApply: () => void; onClose: () => void }) {
  const verb = preview.enabled ? "分发" : "移除";
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4"><section aria-modal="true" className={cn("w-full max-w-[560px] overflow-hidden rounded-lg border", "bg-surface border-line-strong")} role="dialog"><header className={cn("flex items-center justify-between border-b px-5 py-4", "border-line")}><div><p className={cn("font-brand text-[10px] uppercase tracking-[0.1em]", "text-muted")}>变更预览</p><h2 className="mt-1 text-base font-semibold">{verb} {preview.skill_name}</h2></div><button aria-label="关闭变更预览" className={iconButtonClass()} onClick={onClose} type="button"><X className="size-4" /></button></header><div className="space-y-4 p-5"><div className={cn("grid grid-cols-[88px_minmax(0,1fr)] gap-2 rounded-md border p-3 text-xs", "bg-canvas border-line")}><span className="text-faint">Source</span><code className="min-w-0 break-all text-ink-soft">{preview.source_path}</code><span className="text-faint">Target</span><code className="min-w-0 break-all text-ink-soft">{preview.target_path}</code><span className="text-faint">动作</span><span>{preview.action}</span><span className="text-faint">当前状态</span><span>{STATE_LABELS[preview.current_state]}</span></div>{!preview.can_apply && <div className={cn("flex gap-2 rounded-md border px-3 py-2.5 text-xs", "bg-warning-soft border-warning/30 text-warning")}><AlertTriangle className="size-4 shrink-0" />{preview.detail || "Target 存在冲突，禁止覆盖"}</div>}<p className={cn("text-xs leading-5", "text-muted")}>{preview.enabled ? "确认后 Runner 只在 Target 不存在时创建目录软链。" : "确认后 Runner 只移除仍指向当前 Source 的受管软链。"}</p></div><footer className={cn("flex justify-end gap-2 border-t px-5 py-4", "border-line")}><button className={actionClass(false)} onClick={onClose} type="button">取消</button><button className={actionClass(true)} disabled={!preview.can_apply || applying} onClick={onApply} type="button">{applying && <LoaderCircle className="size-4 animate-spin" />}确认{verb}</button></footer></section></div>;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }) { return <section className={cn("border-t py-4", "border-line")}><h4 className={cn("mb-3 font-brand text-[10px] uppercase tracking-[0.08em]", "text-muted")}>{title}</h4>{children}</section>; }
function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) { return <div className="grid grid-cols-[82px_minmax(0,1fr)] gap-2 py-1.5 text-xs"><span className="text-faint">{label}</span><span className={cn("min-w-0 break-all", mono && "font-mono text-[10px]", "text-ink-soft")}>{value}</span></div>; }
function StatePill({ label, issue }: { label: string; issue: boolean }) { return <span className={cn("flex shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[9px]", issue ? "border-warning/30 text-warning" : "border-line text-muted")}><span className={cn("size-1.5 rounded-full", issue ? "bg-warning" : "bg-success")} />{label}</span>; }
function FilterSelect({ label, options, value, onValue }: { label: string; options: Array<[string, string]>; value: string; onValue: (value: string) => void }) { return <Select onValueChange={onValue} value={value}><SelectTrigger aria-label={label} className="h-9 w-full min-w-0 border-line bg-surface px-2.5 text-xs text-ink shadow-none focus-visible:ring-1 max-sm:w-11 max-sm:px-2"><SelectValue /></SelectTrigger><SelectContent className="border-line-strong text-ink-soft shadow-panel" surface="frosted">{options.map(([id, optionLabel]) => <SelectItem className="data-[highlighted]:bg-surface-soft" key={id} value={id}>{optionLabel}</SelectItem>)}</SelectContent></Select>; }
function actionClass(primary: boolean) { return cn("inline-flex h-9 min-w-9 items-center justify-center gap-2 rounded-md border px-3 text-xs transition-opacity hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-50", primary ? "bg-accent text-accent-ink border-accent" : "bg-surface text-ink border-line-strong"); }
function iconButtonClass() { return cn("grid size-9 place-items-center rounded-md border transition-opacity hover:opacity-80", "border-line text-muted"); }
function stateTone(state: SkillProjectionState) { return state === "linked" || state === "native" ? "text-success" : state === "conflict" || state === "broken" ? "text-warning" : "text-muted"; }
function shortPath(value: string) { const parts = value.split("/").filter(Boolean); return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value; }
function agentName(snapshot: SkillCatalogSnapshot | null, id: SkillAgentId) { return snapshot?.targets.find((target) => target.agent_id === id)?.display_name ?? id; }
function messageOf(value: unknown) { return value instanceof Error ? value.message : String(value); }
