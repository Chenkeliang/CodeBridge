import { ChevronDown, ChevronUp, GitBranch, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { revisionTail } from "@/lib/revision-tail";
import type {
  FlowCapability,
  FlowInputRecord,
  FlowRecord,
  FlowReviewContext,
  FlowStepRecord,
} from "@/lib/types";
import { cn } from "@/lib/utils";

export function FlowControlPanel(props: {
  context: FlowReviewContext;
  capabilities: FlowCapability[];
  busy: boolean;
  error: string | null;
  onSave: (flow: FlowRecord) => void;
  onReview: (decision: "approve" | "reject", gitRevision?: string) => void;
  onDeprecate: () => void;
}) {
  const [draft, setDraft] = useState<FlowRecord>(() => structuredClone(props.context.flow));
  const [promotingGuide, setPromotingGuide] = useState(false);
  const [gitRevision, setGitRevision] = useState("");
  const flow = props.context.flow;
  const candidate = flow.kind === "runbook" && flow.status === "candidate";
  const guide = flow.kind === "guide" && flow.status === "draft";
  const canApprove = candidate && props.context.evidence.length > 0 && Boolean(gitRevision.trim()) && !props.busy;

  return <div className="grid gap-4 border-t border-line pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="text-xs font-semibold text-ink">Flow 控制面</p>
        <p className="mt-1 font-mono text-[11px] text-faint">
          lineage {flow.lineage_root_flow_id} · 发布序号 {flow.publication_sequence || "待发布"}
        </p>
      </div>
      {flow.status === "published" && <Button
        className="h-8 text-xs"
        disabled={props.busy}
        onClick={() => {
          if (window.confirm("废弃后将不能再发起新 Run，确认废弃这个 Flow？")) props.onDeprecate();
        }}
        size="sm"
        variant="outline"
      >废弃 Flow</Button>}
    </div>

    {props.error && <p className="rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-xs text-danger" role="alert">{props.error}</p>}

    <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_280px]">
      <div className="min-w-0">
        {guide && !promotingGuide ? <GuideEditor
          disabled={props.busy}
          draft={draft}
          onDraft={setDraft}
          onSave={() => props.onSave(draft)}
          onPromote={() => {
            setDraft(candidateFromGuide(draft));
            setPromotingGuide(true);
          }}
        /> : candidate || promotingGuide ? <CandidateEditor
          capabilities={props.capabilities}
          disabled={props.busy}
          draft={draft}
          onDraft={setDraft}
          onSave={() => props.onSave(draft)}
        /> : <DefinitionSummary flow={flow} />}
      </div>
      <ReviewRail context={props.context} capabilities={props.capabilities} />
    </div>

    {candidate && <div className="grid gap-3 border-t border-line pt-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">Git revision</span>
        <input
          aria-label="Git revision"
          className="h-9 rounded-md border border-line bg-surface-tint px-3 font-mono text-xs text-ink outline-none focus:border-control-accent"
          disabled={props.busy}
          onChange={(event) => setGitRevision(event.target.value)}
          placeholder="仅作审查审计，不参与 Runtime 身份"
          value={gitRevision}
        />
        {!props.context.evidence.length && <span className="text-xs text-warning">先完成当前 revision 的 Dry-run，成功证据会自动出现在右侧。</span>}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button className="h-8 text-xs" disabled={props.busy} onClick={() => props.onReview("reject")} size="sm" variant="outline">打回</Button>
        <Button className="h-8 text-xs" disabled={!canApprove} onClick={() => props.onReview("approve", gitRevision.trim())} size="sm">批准并发布</Button>
      </div>
    </div>}
  </div>;
}

function GuideEditor(props: {
  draft: FlowRecord;
  disabled: boolean;
  onDraft: (flow: FlowRecord) => void;
  onSave: () => void;
  onPromote: () => void;
}) {
  const updateStep = (index: number, patch: Partial<FlowStepRecord>) => props.onDraft({
    ...props.draft,
    steps: props.draft.steps.map((step, valueIndex) => valueIndex === index ? { ...step, ...patch } : step),
  });
  return <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
    <div className="grid gap-3">
      <label className="grid gap-1.5"><span className="text-xs font-medium text-muted">名称</span><input aria-label="Flow 名称" className={controlClass} disabled={props.disabled} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} value={props.draft.name ?? ""} /></label>
      <label className="grid gap-1.5"><span className="text-xs font-medium text-muted">说明</span><textarea aria-label="Flow 说明" className="min-h-20 rounded-md border border-line bg-surface-tint px-3 py-2 text-xs leading-5 text-ink outline-none focus:border-control-accent" disabled={props.disabled} onChange={(event) => props.onDraft({ ...props.draft, description: event.target.value })} value={props.draft.description ?? ""} /></label>
    </div>
    <EditorSection
      action={<Button disabled={props.disabled} onClick={() => props.onDraft({ ...props.draft, steps: [...props.draft.steps, emptyGuideStep(props.draft.steps.length + 1)] })} size="sm" type="button" variant="ghost"><Plus className="size-3.5" />添加步骤</Button>}
      title="人工步骤"
    >
      {props.draft.steps.map((step, index) => <div className="grid gap-2 border-t border-line py-3 first:border-t-0 first:pt-0" key={`${step.id}:${index}`}>
        <div className="grid gap-2 md:grid-cols-[160px_minmax(0,1fr)_auto]">
          <label className="grid gap-1"><span className={miniLabelClass}>Step ID</span><input aria-label={`Guide 步骤 ${index + 1} ID`} className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { id: event.target.value })} value={step.id} /></label>
          <label className="grid gap-1"><span className={miniLabelClass}>目的</span><input aria-label={`Guide 步骤 ${index + 1} 目的`} className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { purpose: event.target.value || null })} value={step.purpose ?? ""} /></label>
          <Button aria-label={`删除 Guide 步骤 ${step.id}`} className="self-end" disabled={props.disabled || props.draft.steps.length === 1} onClick={() => props.onDraft({ ...props.draft, steps: props.draft.steps.filter((_, valueIndex) => valueIndex !== index) })} size="sm" type="button" variant="ghost"><Trash2 className="size-3.5" /></Button>
        </div>
        <label className="grid gap-1"><span className={miniLabelClass}>依赖（逗号分隔）</span><input className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { depends_on: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} value={step.depends_on.join(", ")} /></label>
      </div>)}
    </EditorSection>
    <p className="text-xs leading-5 text-faint">Guide 仅用于整理草稿；补齐 Capability、验收条件并转成 Candidate 后才能 Dry-run。</p>
    <div className="flex gap-2"><Button className="h-8 text-xs" disabled={props.disabled} size="sm" type="submit">保存 Guide 草稿</Button><Button className="h-8 text-xs" disabled={props.disabled} onClick={props.onPromote} size="sm" type="button" variant="outline">升级为 Candidate</Button></div>
  </form>;
}

function CandidateEditor(props: {
  draft: FlowRecord;
  capabilities: FlowCapability[];
  disabled: boolean;
  onDraft: (flow: FlowRecord) => void;
  onSave: () => void;
}) {
  const updateInput = (index: number, patch: Partial<FlowInputRecord>) => props.onDraft({
    ...props.draft,
    inputs: props.draft.inputs.map((input, valueIndex) => valueIndex === index ? { ...input, ...patch } : input),
  });
  const updateStep = (index: number, patch: Partial<FlowStepRecord>) => props.onDraft({
    ...props.draft,
    steps: props.draft.steps.map((step, valueIndex) => valueIndex === index ? { ...step, ...patch } : step),
  });
  const moveStep = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= props.draft.steps.length) return;
    const steps = [...props.draft.steps];
    [steps[index], steps[target]] = [steps[target]!, steps[index]!];
    props.onDraft({ ...props.draft, steps });
  };

  return <form className="grid gap-5" onSubmit={(event) => { event.preventDefault(); props.onSave(); }}>
    <div className="grid gap-3">
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">名称</span>
        <input aria-label="Flow 名称" className={controlClass} disabled={props.disabled} onChange={(event) => props.onDraft({ ...props.draft, name: event.target.value })} value={props.draft.name ?? ""} />
      </label>
      <label className="grid gap-1.5">
        <span className="text-xs font-medium text-muted">说明</span>
        <textarea aria-label="Flow 说明" className="min-h-20 rounded-md border border-line bg-surface-tint px-3 py-2 text-xs leading-5 text-ink outline-none focus:border-control-accent" disabled={props.disabled} onChange={(event) => props.onDraft({ ...props.draft, description: event.target.value })} value={props.draft.description ?? ""} />
      </label>
    </div>

    <EditorSection
      action={<Button disabled={props.disabled} onClick={() => props.onDraft({
        ...props.draft,
        inputs: [...props.draft.inputs, { id: `input_${props.draft.inputs.length + 1}`, type: "string", source: "user", required: true }],
      })} size="sm" type="button" variant="ghost"><Plus className="size-3.5" />添加输入</Button>}
      title="Inputs"
    >
      {props.draft.inputs.length === 0 ? <EmptyLine text="这个 Flow 没有声明输入。" /> : props.draft.inputs.map((input, index) => <div className="grid gap-2 border-t border-line py-3 first:border-t-0 first:pt-0 md:grid-cols-[1fr_120px_120px_auto]" key={`${input.id}:${index}`}>
        <label className="grid gap-1"><span className={miniLabelClass}>字段</span><input aria-label={`输入 ${index + 1} ID`} className={controlClass} disabled={props.disabled} onChange={(event) => updateInput(index, { id: event.target.value })} value={input.id} /></label>
        <label className="grid gap-1"><span className={miniLabelClass}>类型</span><select className={controlClass} disabled={props.disabled} onChange={(event) => updateInput(index, { type: event.target.value })} value={input.type}>{["string", "integer", "enum", "directory", "secret_ref"].map((type) => <option key={type}>{type}</option>)}</select></label>
        <label className="grid gap-1"><span className={miniLabelClass}>来源</span><select className={controlClass} disabled={props.disabled} onChange={(event) => updateInput(index, { source: event.target.value })} value={input.source}>{["user", "context", "agent", "step_output", "default"].map((source) => <option key={source}>{source}</option>)}</select></label>
        <div className="flex items-end gap-1">
          <label className="flex h-9 items-center gap-1.5 text-xs text-muted"><input checked={input.required} disabled={props.disabled} onChange={(event) => updateInput(index, { required: event.target.checked })} type="checkbox" />必填</label>
          <Button aria-label={`删除输入 ${input.id}`} disabled={props.disabled} onClick={() => props.onDraft({ ...props.draft, inputs: props.draft.inputs.filter((_, valueIndex) => valueIndex !== index) })} size="sm" type="button" variant="ghost"><Trash2 className="size-3.5" /></Button>
        </div>
      </div>)}
    </EditorSection>

    <EditorSection
      action={<Button disabled={props.disabled} onClick={() => props.onDraft({
        ...props.draft,
        steps: [...props.draft.steps, emptyStep(props.draft.steps.length + 1)],
      })} size="sm" type="button" variant="ghost"><Plus className="size-3.5" />添加步骤</Button>}
      title="有序步骤"
    >
      {props.draft.steps.length === 0 ? <EmptyLine text="至少添加一个可执行步骤。" /> : props.draft.steps.map((step, index) => {
        const capability = props.capabilities.find((item) => item.id === step.capability);
        return <div className="grid gap-3 border-t border-line py-4 first:border-t-0 first:pt-0" key={`${step.id}:${index}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-xs text-faint">{String(index + 1).padStart(2, "0")}</span>
            <div className="flex gap-1">
              <Button aria-label={`上移步骤 ${step.id}`} disabled={props.disabled || index === 0} onClick={() => moveStep(index, -1)} size="sm" type="button" variant="ghost"><ChevronUp className="size-3.5" /></Button>
              <Button aria-label={`下移步骤 ${step.id}`} disabled={props.disabled || index === props.draft.steps.length - 1} onClick={() => moveStep(index, 1)} size="sm" type="button" variant="ghost"><ChevronDown className="size-3.5" /></Button>
              <Button aria-label={`删除步骤 ${step.id}`} disabled={props.disabled} onClick={() => props.onDraft({ ...props.draft, steps: props.draft.steps.filter((_, valueIndex) => valueIndex !== index) })} size="sm" type="button" variant="ghost"><Trash2 className="size-3.5" /></Button>
            </div>
          </div>
          <div className="grid gap-2 md:grid-cols-2">
            <label className="grid gap-1"><span className={miniLabelClass}>Step ID</span><input aria-label={`步骤 ${index + 1} ID`} className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { id: event.target.value })} value={step.id} /></label>
            <label className="grid gap-1"><span className={miniLabelClass}>Capability</span><select aria-label={`步骤 ${index + 1} Capability`} className={controlClass} disabled={props.disabled} onChange={(event) => {
              const selected = props.capabilities.find((item) => item.id === event.target.value);
              updateStep(index, { capability: event.target.value || null, mode: selected?.risk ?? step.mode });
            }} value={step.capability ?? ""}><option value="">选择 Capability</option>{props.capabilities.map((item) => <option key={item.id} value={item.id}>{item.id}</option>)}</select></label>
            <label className="grid gap-1 md:col-span-2"><span className={miniLabelClass}>目的</span><input className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { purpose: event.target.value || null })} value={step.purpose ?? ""} /></label>
            <label className="grid gap-1"><span className={miniLabelClass}>依赖（逗号分隔）</span><input className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { depends_on: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) })} value={step.depends_on.join(", ")} /></label>
            <label className="grid gap-1"><span className={miniLabelClass}>审批</span><select className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { approval: event.target.value as "none" | "required" })} value={step.approval}><option value="none">none</option><option value="required">required</option></select></label>
            <label className="grid gap-1 md:col-span-2"><span className={miniLabelClass}>success_when</span><input className={controlClass} disabled={props.disabled} onChange={(event) => updateStep(index, { success_when: event.target.value || null })} value={step.success_when ?? ""} /></label>
          </div>
          <p className="font-mono text-[11px] text-faint">adapter {capability?.adapter ?? "未映射"} · risk {capability?.risk ?? step.mode ?? "未定义"}</p>
        </div>;
      })}
    </EditorSection>

    <div><Button className="h-8 text-xs" disabled={props.disabled} size="sm" type="submit">保存 Candidate</Button></div>
  </form>;
}

function ReviewRail({ context, capabilities }: { context: FlowReviewContext; capabilities: FlowCapability[] }) {
  const diffItems = [
    context.diff.name_changed ? "名称" : null,
    context.diff.description_changed ? "说明" : null,
    ...context.diff.inputs.added.map((id) => `新增 input: ${id}`),
    ...context.diff.inputs.removed.map((id) => `删除 input: ${id}`),
    ...context.diff.inputs.changed.map((id) => `修改 input: ${id}`),
    ...context.diff.steps.added.map((id) => `新增 step: ${id}`),
    ...context.diff.steps.removed.map((id) => `删除 step: ${id}`),
    ...context.diff.steps.changed.map((id) => `修改 step: ${id}`),
    context.diff.steps.reordered ? "步骤顺序" : null,
  ].filter((value): value is string => Boolean(value));
  return <aside className="grid content-start gap-5 border-t border-line pt-4 md:border-l md:border-t-0 md:pl-5 md:pt-0">
    <RailSection title="语义 Diff">
      {diffItems.length ? <ul className="grid gap-1 text-xs text-ink-soft">{diffItems.map((item) => <li key={item}>{item}</li>)}</ul> : <EmptyLine text="与来源 revision 没有语义变化。" />}
    </RailSection>
    <RailSection title="Provenance">
      {context.provenance ? <dl className="grid gap-1 font-mono text-[11px] text-muted"><dt>run</dt><dd className="break-all text-ink-soft">{context.provenance.source_run_id}</dd><dt>source</dt><dd className="break-all text-ink-soft">{context.provenance.source_flow_id}</dd><dt>revision</dt><dd className="text-ink-soft">{revisionTail(context.provenance.source_definition_revision)}</dd></dl> : <EmptyLine text="旧记录没有来源链。" />}
    </RailSection>
    <RailSection title="Dry-run 证据">
      {context.evidence.length ? <ul className="grid gap-2">{context.evidence.map((item) => <li className="border-t border-line pt-2 first:border-t-0 first:pt-0" key={item.run_id}><p className="font-mono text-[11px] text-success">{item.run_id}</p><p className="mt-0.5 text-[11px] text-faint">rev {revisionTail(item.definition_revision)} · succeeded</p></li>)}</ul> : <EmptyLine text="当前 revision 尚无成功 Dry-run。" />}
    </RailSection>
    <RailSection title="Capability 映射">
      <ul className="grid gap-2">{context.flow.steps.map((step) => {
        const capability = capabilities.find((item) => item.id === step.capability);
        return <li className="font-mono text-[11px]" key={step.id}><p className="text-ink-soft">{step.capability ?? step.id}</p><p className="text-faint">{capability?.adapter ?? "未映射"} · {capability?.risk ?? step.mode ?? "未定义"}</p></li>;
      })}</ul>
    </RailSection>
    <RailSection title="审计历史">
      <ol className="grid gap-2">{context.history.map((entry) => <li className="flex items-start justify-between gap-2 text-[11px]" key={entry.id}><span className="text-ink-soft">{entry.action}</span><span className="font-mono text-faint">{revisionTail(entry.definition_revision)}</span></li>)}</ol>
    </RailSection>
  </aside>;
}

function DefinitionSummary({ flow }: { flow: FlowRecord }) {
  return <div className="grid gap-4">
    <div><p className="text-xs font-medium text-muted">说明</p><p className="mt-1 text-sm leading-6 text-ink-soft">{flow.description || "无说明"}</p></div>
    <EditorSection title="定义"><ol className="grid gap-2">{flow.steps.map((step, index) => <li className="grid grid-cols-[28px_1fr] gap-2 text-xs" key={step.id}><span className="font-mono text-faint">{String(index + 1).padStart(2, "0")}</span><span><span className="font-mono text-ink-soft">{step.capability ?? step.id}</span><span className="ml-2 text-faint">{step.success_when}</span></span></li>)}</ol></EditorSection>
  </div>;
}

function EditorSection({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return <section className="grid gap-3 border-t border-line pt-3"><header className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-2 text-xs font-semibold text-ink"><GitBranch className="size-3.5 text-faint" />{title}</h3>{action}</header>{children}</section>;
}

function RailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="grid gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>{children}</section>;
}

function EmptyLine({ text }: { text: string }) {
  return <p className="text-xs leading-5 text-faint">{text}</p>;
}

function emptyStep(index: number): FlowStepRecord {
  return { id: `step_${index}`, capability: null, purpose: null, depends_on: [], mode: "read_only", approval: "none", branches: [], retry: null, success_when: null };
}

function emptyGuideStep(index: number): FlowStepRecord {
  return { id: `step_${index}`, capability: null, purpose: "", depends_on: [], mode: "manual", approval: "none", branches: [], retry: null, success_when: null };
}

function candidateFromGuide(guide: FlowRecord): FlowRecord {
  return {
    ...guide,
    flow_id: "",
    kind: "runbook",
    status: "candidate",
    source: "user_selected",
    definition_revision: "",
    plan_ir_hash: null,
    parent_flow_id: guide.flow_id,
    review_status: "pending",
    steps: guide.steps.map((step) => ({
      ...step,
      capability: null,
      mode: "read_only",
      success_when: null,
    })),
  };
}

const controlClass = cn("h-9 min-w-0 rounded-md border border-line bg-surface-tint px-3 font-mono text-xs text-ink outline-none focus:border-control-accent disabled:opacity-60");
const miniLabelClass = "text-[11px] text-faint";
