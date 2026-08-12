import { useEffect, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, FileText, FolderOpen, Gauge, LoaderCircle, Paperclip, Plus, Send, Square, Workflow, X, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import type { AgentCommand, AgentSession, ConfigOption, FlowRecord, MessageAttachmentInput, WorkspaceListing } from "@/lib/types";
import { cn } from "@/lib/utils";
import { applyComposerSuggestion, attachmentPreviewUrl, composerTrigger, filterCommands, speedValueLabel, workspacePaths } from "@/lib/workbench-logic";
import { DEFAULT_SELECT_VALUE, defaultModelLabel, workspaceLabel } from "@/components/workbench-shared";

const TYPEWRITER_HINTS = [
  "输入目标，或继续当前工作…",
  "试试：/review 让 Agent 审查当前变更",
  "@ 引用工作区文件，/ 唤起命令",
  "⌘K 打开命令面板",
];

const TYPE_INTERVAL = 55;   // ms per character
const HOLD_MS = 2000;
const NEXT_MS = 400;

/** Rotating typewriter placeholder shown while the draft is empty and the
 *  textarea is not focused. Characters appear one by one via CSS animation
 *  delays, so timing is exact and independent of CJK font metrics. */
function TypewriterPlaceholder({ active }: { active: boolean }) {
  const [line, setLine] = useState(0);
  useEffect(() => {
    if (!active) return;
    const current = TYPEWRITER_HINTS[line]!;
    const duration = current.length * TYPE_INTERVAL + HOLD_MS + NEXT_MS;
    const timer = window.setTimeout(() => setLine((value) => (value + 1) % TYPEWRITER_HINTS.length), duration);
    return () => window.clearTimeout(timer);
  }, [active, line]);
  if (!active) return null;
  const hint = TYPEWRITER_HINTS[line]!;
  return <div aria-hidden="true" className={cn("pointer-events-none absolute inset-x-3.5 top-3 font-mono text-sm", "text-faint")}>
    <span className="typewriter-line" key={line}>
      {[...hint].map((ch, index) => <span className="typewriter-ch" key={`${line}-${index}`} style={{ animationDelay: `${index * TYPE_INTERVAL}ms` }}>{ch === " " ? " " : ch}</span>)}
    </span>
    <span className="typewriter-caret" />
  </div>;
}

export function Composer({ attachments, commands, contextOpen, workspaceListing, workspaceLoading, disabled, draft, flowId, flows, model, modelOption, effort, thoughtLevelOption, configOverrides, speedOption, permissionMode, permissionOption, sending, session, commandOpen, running, onAddFiles, onCommandOpen, onContext, onContextNavigate, onContextOpen, onDraft, onFiles, onFlow, onModel, onEffort, onConfigOverride, onPermissionMode, onPickDirectory, onRemoveAttachment, onSubmit, onStop }: {
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
  onStop: () => void;
  running: boolean;
}) {
  const trigger = composerTrigger(draft);
  const visibleCommands = filterCommands(commands, trigger?.kind === "command" ? trigger.query : "");
  const contextQuery = trigger?.kind === "context" ? trigger.query.toLowerCase() : "";
  const visibleEntries = (workspaceListing?.entries ?? []).filter((entry) => !contextQuery || `${entry.name} ${entry.path}`.toLowerCase().includes(contextQuery));
  const hasWorkspace = workspacePaths(session).length > 0;
  const [commandIndex, setCommandIndex] = useState(0);
  const [contextIndex, setContextIndex] = useState(0);
  useEffect(() => setCommandIndex(0), [commandOpen, trigger?.kind === "command" ? trigger.query : ""]);
  useEffect(() => setContextIndex(0), [contextOpen, contextQuery, workspaceListing?.path]);

  function pickCommand(index: number) {
    const command = visibleCommands[index];
    if (!command) return;
    onDraft(applyComposerSuggestion(draft, `/${command.name} `));
    onCommandOpen(false);
  }

  function pickEntry(index: number) {
    const entry = visibleEntries[index];
    if (!entry) return;
    if (entry.kind === "directory") onContextNavigate(entry.path, workspaceListing?.root);
    else { onContext(entry.absolutePath); onContextOpen(false); }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") { onCommandOpen(false); onContextOpen(false); return; }
    if (commandOpen && visibleCommands.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setCommandIndex((i) => (i + 1) % visibleCommands.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setCommandIndex((i) => (i - 1 + visibleCommands.length) % visibleCommands.length); return; }
      if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") { event.preventDefault(); pickCommand(commandIndex); return; }
    }
    if (contextOpen && visibleEntries.length > 0) {
      if (event.key === "ArrowDown") { event.preventDefault(); setContextIndex((i) => (i + 1) % visibleEntries.length); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setContextIndex((i) => (i - 1 + visibleEntries.length) % visibleEntries.length); return; }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey && visibleEntries[contextIndex]?.kind !== "directory")) { event.preventDefault(); pickEntry(contextIndex); return; }
    }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submitWithSweep(); }
  }
  const [sweepKey, setSweepKey] = useState(0);
  function submitWithSweep() {
    if (!disabled && !sending && draft.trim()) setSweepKey((value) => value + 1);
    onSubmit();
  }
  const [focused, setFocused] = useState(false);
  const showTypewriter = !draft && !disabled && !focused;

  return <div className={cn("relative rounded-xl border", "bg-surface", "border-line-strong", "shadow-panel", running && "motion-safe:animate-breathe")}>
    <div className="flex min-w-0 items-center gap-1.5 overflow-x-auto px-3 pt-2.5 [mask-image:linear-gradient(to_right,black_90%,transparent)]">
      {modelOption ? <SessionConfigSelect label={defaultModelLabel(modelOption)} onValue={onModel} option={modelOption} value={model} /> : <ContextChip label="Agent 默认" />}
      {thoughtLevelOption && <ReasoningLevelControl onValue={onEffort} option={thoughtLevelOption} value={effort} />}
      {speedOption && <SpeedControl onValue={(value) => onConfigOverride(speedOption, value)} option={speedOption} overridden={Object.hasOwn(configOverrides, speedOption.id)} value={String(configOverrides[speedOption.id] ?? speedOption.currentValue ?? "false")} />}
      {permissionOption && <SessionConfigSelect label="Agent 默认" onValue={onPermissionMode} option={permissionOption} value={permissionMode} />}
      <button className={cn("inline-flex min-h-7 shrink-0 items-center gap-1.5 rounded border px-2 text-[11px] transition-opacity hover:opacity-80", "bg-surface-soft", "text-muted", "border-line")} onClick={onPickDirectory} type="button"><FolderOpen className="size-3" /><span className={cn("font-medium", "text-ink-soft")}>{workspaceLabel(session)}</span></button>
      {flows.length > 0 && <div className={cn("inline-flex min-h-7 shrink-0 items-center rounded border pl-2 text-[11px]", "bg-surface-soft", "text-muted", "border-line")}><Workflow className="mr-1 size-3" /><Select onValueChange={(value) => onFlow(value === DEFAULT_SELECT_VALUE ? "" : value)} value={flowId || DEFAULT_SELECT_VALUE}>
        <SelectTrigger aria-label="Flow" className={cn("h-7 max-w-44 gap-1 border-0 bg-transparent px-1.5 py-0 text-[11px] shadow-none focus-visible:ring-0", "text-ink-soft")}><SelectValue /></SelectTrigger>
        <SelectContent className={cn("bg-surface", "text-ink-soft", "border-line-strong", "shadow-panel")}>
          <SelectItem className={"data-[highlighted]:bg-surface-soft"} value={DEFAULT_SELECT_VALUE}>Flow · 自动</SelectItem>
          {flows.map((flow) => <SelectItem className={"data-[highlighted]:bg-surface-soft"} key={flow.flow_id} value={flow.flow_id}>{flow.name || flow.flow_id}</SelectItem>)}
        </SelectContent>
      </Select></div>}
      <span className="flex-1" /><span className={cn("hidden shrink-0 text-[11px] sm:inline", "text-faint")}>Enter 发送</span>
    </div>
    {attachments.length > 0 && <div className="flex flex-wrap gap-2 px-3 pt-2">{attachments.map((attachment, index) => {
      const preview = attachmentPreviewUrl(attachment);
      return <div className={cn("group relative overflow-hidden rounded-md border", "motion-safe:animate-chip-pop", preview ? "size-16" : "inline-flex items-center gap-1.5 px-2 py-1 text-[11px]", "bg-surface-tint", "text-ink-soft", "border-line")} key={`${attachment.name}-${index}`} style={{ animationDelay: `${index * 50}ms` }}>
        {preview ? <img alt={attachment.name} className="size-full object-cover" src={preview} /> : <><Paperclip className="size-3" /><span className="max-w-40 truncate">{attachment.name}</span></>}
        <button aria-label={`移除 ${attachment.name}`} className={cn(preview && "absolute right-1 top-1 grid size-5 place-items-center rounded-full", preview && "bg-surface")} onClick={() => onRemoveAttachment(index)} type="button"><X className="size-3" /></button>
      </div>;
    })}</div>}
    <div className="relative">
      <Textarea aria-label="消息" className={cn("min-h-[76px] resize-none border-0 bg-transparent px-3.5 py-3 text-sm shadow-none focus:border-0 focus:ring-0", "text-ink", showTypewriter ? "placeholder:text-transparent" : "placeholder:text-faint")} disabled={disabled || sending} onChange={(event) => { const value = event.target.value; const nextTrigger = composerTrigger(value); onCommandOpen(nextTrigger?.kind === "command" && commands.length > 0); onContextOpen(nextTrigger?.kind === "context" && hasWorkspace); onDraft(value); }} onKeyDown={handleKeyDown} onPaste={(event: ClipboardEvent<HTMLTextAreaElement>) => { if (event.clipboardData.files.length) void onAddFiles(event.clipboardData.files); }} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} placeholder="输入目标，或继续当前工作…" value={draft} />
      {showTypewriter && <TypewriterPlaceholder active />}
    </div>
    <div className="flex items-center justify-between gap-3 px-3 pb-2.5">
      <div className="flex items-center gap-1">
        <Button aria-label="添加文件" className={cn("size-8 px-0", "text-muted")} onClick={onFiles} size="icon" title="添加文件或图片" variant="ghost"><Plus className="size-3.5" /></Button>
        {session && hasWorkspace && <Button aria-label="插入上下文" className={cn("size-8 px-0 text-xs", "text-muted")} onClick={() => onContextOpen(!contextOpen)} size="icon" variant="ghost"><span>@</span></Button>}
        {contextOpen && hasWorkspace && <div className={cn("absolute bottom-[calc(100%+0.5rem)] left-12 z-30 w-[420px] overflow-hidden rounded-lg border", "bg-surface", "border-line-strong", "shadow-panel")}>
          <div className={cn("flex h-9 items-center gap-2 border-b px-2.5 text-[11px]", "border-line", "text-muted")}>
            {workspaceListing?.relativePath && <button aria-label="返回上级目录" className="grid size-6 place-items-center rounded-md hover:opacity-70" onClick={() => onContextNavigate(workspaceListing.relativePath!.split("/").slice(0, -1).join("/"), workspaceListing.root)} type="button"><ChevronDown className="size-3.5 rotate-90" /></button>}
            <FolderOpen className="size-3.5" /><span className="min-w-0 flex-1 truncate font-mono">{workspaceListing?.path ?? workspacePaths(session)[0]}</span>
          </div>
          <div className="max-h-72 overflow-y-auto p-1">
            {workspaceLoading ? <div className={cn("px-3 py-6 text-center text-xs", "text-muted")}>正在读取 Workspace…</div> : visibleEntries.length ? visibleEntries.map((entry, index) => <button aria-selected={index === contextIndex} className={cn("flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs hover:opacity-80", "text-ink", index === contextIndex && "bg-surface-soft")} key={entry.absolutePath} onClick={() => pickEntry(index)} onMouseEnter={() => setContextIndex(index)} ref={index === contextIndex ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined} type="button">{entry.kind === "directory" ? <FolderOpen className={cn("size-3.5 shrink-0", "text-muted")} /> : <FileText className={cn("size-3.5 shrink-0", "text-muted")} />}<span className="min-w-0 flex-1 truncate">{entry.name}</span><span className={cn("max-w-48 truncate font-mono text-[11px]", "text-faint")}>{entry.path}</span>{entry.kind === "directory" && <ChevronRight className={cn("size-3.5 shrink-0", "text-faint")} />}</button>) : <div className={cn("px-3 py-6 text-center text-xs", "text-muted")}>没有匹配的文件或目录</div>}
          </div>
        </div>}
        {commands.length > 0 && <Button aria-label="Agent commands" className={cn("size-8 px-0 text-xs", "text-muted")} onClick={() => onCommandOpen(!commandOpen)} size="icon" variant="ghost"><span>/</span></Button>}
        {commandOpen && visibleCommands.length > 0 && <div className={cn("absolute bottom-[calc(100%+0.5rem)] left-3 z-30 max-h-72 w-[420px] overflow-y-auto rounded-lg border p-1", "bg-surface", "border-line-strong", "shadow-panel")}>{visibleCommands.map((command, index) => <button aria-selected={index === commandIndex} className={cn("grid w-full gap-0.5 rounded-md px-3 py-2.5 text-left hover:opacity-80", "text-ink", index === commandIndex && "bg-surface-soft")} key={command.name} onClick={() => pickCommand(index)} onMouseEnter={() => setCommandIndex(index)} ref={index === commandIndex ? (node) => node?.scrollIntoView({ block: "nearest" }) : undefined} type="button"><span className="font-mono text-xs">/{command.name}</span><span className={cn("truncate text-[11px]", "text-muted")}>{command.description}</span></button>)}</div>}
      </div>
      <div className="flex items-center gap-1.5">
        {running && <Button aria-label="停止当前 Run" className={cn("size-8 px-0", "bg-danger-soft", "text-danger")} onClick={onStop} size="icon" title="停止当前 Run"><Square className="size-3.5 fill-current" /></Button>}
        <Button aria-label="发送" className={cn("size-8 px-0 transition-transform active:translate-y-px", "bg-accent", "text-accent-ink")} disabled={disabled || sending || !draft.trim()} onClick={submitWithSweep} size="icon">{sending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}</Button>
      </div>
    </div>
    {sweepKey > 0 && <span aria-hidden="true" className="composer-sweep sent" key={sweepKey} />}
  </div>;
}


function ContextChip({ label }: { label: string }) {
  return <span className={cn("inline-flex min-h-7 max-w-44 shrink-0 items-center rounded border px-2 text-[11px]", "bg-surface-soft", "border-line")}><span className={cn("truncate font-medium", "text-ink-soft")}>{label}</span></span>;
}

function ReasoningLevelControl({ onValue, option, value }: { onValue: (value: string) => void; option: ConfigOption; value: string }) {
  const selectableLevels = option.values.filter((candidate) => candidate.value.toLowerCase() !== "default");
  const levels = selectableLevels.length ? selectableLevels : option.values;
  const effectiveValue = value || option.currentValue || levels[0]?.value || "";
  const committedIndex = Math.max(0, levels.findIndex((candidate) => candidate.value === effectiveValue));
  const [previewIndex, setPreviewIndex] = useState(committedIndex);
  useEffect(() => setPreviewIndex(committedIndex), [committedIndex]);
  const active = levels[previewIndex] ?? levels[0]!;
  const activeLabel = active.name || active.value;
  return <Popover>
    <PopoverTrigger asChild>
      <Button aria-label={option.name} className={cn("h-7 max-w-44 shrink-0 gap-1 border px-2 py-0 text-[11px] shadow-none", "bg-surface-soft", value ? "text-ink-soft" : "text-muted", "border-line", "hover:bg-line")} title={activeLabel} type="button" variant="outline"><Zap className="size-3" /><span className="truncate">{activeLabel}</span><ChevronDown className="size-3 opacity-60" /></Button>
    </PopoverTrigger>
    <PopoverContent align="start" className={cn("w-72", "bg-surface", "text-ink-soft", "border-line-strong", "shadow-panel")} side="top">
      <div className="mb-5 flex items-center justify-between gap-3"><span className={cn("text-xs font-medium", "text-ink")}>推理强度</span><span className="flex min-w-0 items-center gap-2">{value && <span className={cn("text-[11px] underline underline-offset-2", "text-muted")}><button onClick={() => onValue("")}>恢复默认</button></span>}<span className={cn("truncate text-[11px]", "text-muted")}>{activeLabel}</span></span></div>
      <div className="relative py-1">
        <div className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 justify-between">{levels.map((level, index) => <span className={cn("size-1 rounded-full bg-current motion-safe:transition-[color,transform] motion-safe:duration-150", previewIndex >= index ? "text-control-accent" : "text-faint", previewIndex === index && "scale-150")} key={`${level.value}-${index}`} />)}</div>
        <Slider aria-label="Reasoning level" className={"text-control-accent"} max={levels.length - 1} min={0} onValueChange={([index]) => setPreviewIndex(index ?? 0)} onValueCommit={([index]) => onValue(levels[index ?? 0]?.value ?? "")} step={1} value={[previewIndex]} />
      </div>
      <div className={cn("mt-3 flex justify-between text-[11px]", "text-faint")}><span>{levels[0]?.name}</span><span>{levels.at(-1)?.name}</span></div>
      <p className={cn("mt-3 min-h-4 text-[11px] leading-4", "text-muted")}>{active.description ?? "Agent 提供的推理等级"}</p>
    </PopoverContent>
  </Popover>;
}

function SpeedControl({ onValue, option, overridden, value }: { onValue: (value: string) => void; option: ConfigOption; overridden: boolean; value: string }) {
  const selected = option.values.find((candidate) => candidate.value === value);
  const label = speedValueLabel(selected?.value ?? value, selected?.name);
  return <Select onValueChange={(next) => onValue(next === DEFAULT_SELECT_VALUE ? "" : next)} value={overridden ? value : DEFAULT_SELECT_VALUE}>
    <SelectTrigger aria-label="速度" className={cn("h-7 max-w-44 shrink-0 gap-1 border px-2 py-0 text-[11px] shadow-none focus-visible:ring-1", "bg-surface-soft", overridden ? "text-ink-soft" : "text-muted", "border-line", "focus:border-muted focus-visible:ring-line-strong")} title={selected?.description}><Gauge className="size-3" /><SelectValue>{label}</SelectValue></SelectTrigger>
    <SelectContent className={cn("max-w-80", "bg-surface", "text-ink-soft", "border-line-strong", "shadow-panel")}>
      <SelectItem className={"data-[highlighted]:bg-surface-soft"} value={DEFAULT_SELECT_VALUE}>跟随默认（{speedValueLabel(option.currentValue ?? "false")}）</SelectItem>
      {option.values.map((candidate) => <SelectItem className={"data-[highlighted]:bg-surface-soft"} key={candidate.value} textValue={speedValueLabel(candidate.value, candidate.name)} value={candidate.value}><span className="grid gap-0.5 py-0.5"><span>{speedValueLabel(candidate.value, candidate.name)}</span><span className={cn("max-w-72 text-[11px] font-normal leading-4", "text-muted")}>{candidate.description ?? (speedValueLabel(candidate.value, candidate.name) === "快速" ? "响应更快，配额消耗更高" : "标准响应速度")}</span></span></SelectItem>)}
    </SelectContent>
  </Select>;
}

function SessionConfigSelect({ label, onValue, option, value }: { label: string; onValue: (value: string) => void; option: ConfigOption; value: string }) {
  const selected = option.values.find((candidate) => candidate.value === value);
  const triggerLabel = selected ? selected.name || selected.value : label;
  return <Select onValueChange={(next) => onValue(next === DEFAULT_SELECT_VALUE ? "" : next)} value={value || DEFAULT_SELECT_VALUE}>
    <SelectTrigger aria-label={option.name} className={cn("h-7 max-w-52 shrink-0 gap-1 border px-2 py-0 text-[11px] shadow-none focus-visible:ring-1", "bg-surface-soft", value ? "text-ink-soft" : "text-muted", "border-line", "focus:border-muted focus-visible:ring-line-strong")} title={selected?.description}><SelectValue>{triggerLabel}</SelectValue></SelectTrigger>
    <SelectContent className={cn("max-w-80", "bg-surface", "text-ink-soft", "border-line-strong", "shadow-panel")}>
      <SelectItem className={"data-[highlighted]:bg-surface-soft"} value={DEFAULT_SELECT_VALUE}>{label}</SelectItem>
      {option.values.map((candidate) => <SelectItem className={"data-[highlighted]:bg-surface-soft"} key={candidate.value} textValue={candidate.name || candidate.value} value={candidate.value}><span className="grid gap-0.5 py-0.5"><span>{candidate.name || candidate.value}</span>{candidate.description && <span className={cn("max-w-72 text-[11px] font-normal leading-4", "text-muted")}>{candidate.description}</span>}</span></SelectItem>)}
    </SelectContent>
  </Select>;
}

