import { useState, type ReactNode } from "react";
import { ChevronDown, FolderOpen, Gauge, Paperclip, Plus, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Slider } from "@/components/ui/slider";
import { DEFAULT_SELECT_VALUE, defaultModelLabel } from "@/components/workbench-shared";
import type { ConfigOption, FlowRecord } from "@/lib/types";
import { speedValueLabel } from "@/lib/workbench-logic";
import { cn } from "@/lib/utils";

export function ComposerActions({ flowId, flows, hasWorkspace, onFiles, onFlow, onPickDirectory, onWorkspaceContext }: {
  flowId: string;
  flows: FlowRecord[];
  hasWorkspace: boolean;
  onFiles: () => void;
  onFlow: (value: string) => void;
  onPickDirectory: () => void;
  onWorkspaceContext: () => void;
}) {
  return <Popover>
    <PopoverTrigger asChild>
      <Button aria-label="Composer actions" className="size-8 px-0" size="icon" title="添加内容" variant="ghost">
        <Plus className="size-4" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="grid w-64 gap-1 border-line-strong p-1.5 text-ink-soft shadow-panel" side="top" surface="frosted">
      <ActionButton icon={<Paperclip className="size-3.5" />} label="添加文件" onClick={onFiles} />
      <ActionButton disabled={!hasWorkspace} icon={<FolderOpen className="size-3.5" />} label="插入 Workspace 上下文" onClick={onWorkspaceContext} />
      <ActionButton icon={<Plus className="size-3.5" />} label="添加 Workspace" onClick={onPickDirectory} />
      {flows.filter((flow) => flow.status === "published").length > 0 && <div className="mt-1 border-t border-line pt-1">
        <Select onValueChange={(value) => onFlow(value === DEFAULT_SELECT_VALUE ? "" : value)} value={flowId || DEFAULT_SELECT_VALUE}>
          <SelectTrigger aria-label="Flow" className="h-8 w-full justify-start gap-2 border-0 bg-transparent px-2 py-0 text-xs shadow-none focus-visible:ring-0">
            <Workflow className="size-3.5" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="border-line-strong text-ink-soft shadow-panel" surface="frosted">
            <SelectItem className="data-[highlighted]:bg-surface-soft" value={DEFAULT_SELECT_VALUE}>Flow · 自动</SelectItem>
            {flows.filter((flow) => flow.status === "published").map((flow) => <SelectItem className="data-[highlighted]:bg-surface-soft" key={flow.flow_id} value={flow.flow_id}>{flow.name || flow.flow_id}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>}
    </PopoverContent>
  </Popover>;
}

function ActionButton({ disabled = false, icon, label, onClick }: {
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return <button
    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-ink-soft hover:bg-surface-soft disabled:opacity-50"
    disabled={disabled}
    onClick={onClick}
    type="button"
  >
    {icon}{label}
  </button>;
}

export function PermissionControl({ onValue, option, value }: {
  option?: ConfigOption;
  value: string;
  onValue: (value: string) => void;
}) {
  if (!option) return null;
  return <SessionConfigSelect ariaLabel="Permission" label="Agent 默认" onValue={onValue} option={option} value={value} />;
}

export function ModelControls({ configOverrides, effort, model, modelOption, onConfigOverride, onEffort, onModel, speedOption, thoughtLevelOption }: {
  model: string;
  modelOption?: ConfigOption;
  effort: string;
  thoughtLevelOption?: ConfigOption;
  configOverrides: Record<string, string | boolean>;
  speedOption?: ConfigOption;
  onModel: (value: string) => void;
  onEffort: (value: string) => void;
  onConfigOverride: (option: ConfigOption, value: string) => void;
}) {
  if (!modelOption && !thoughtLevelOption && !speedOption) {
    return <span className="inline-flex h-8 max-w-44 items-center rounded-md px-2 text-xs text-muted">Agent 默认</span>;
  }
  const effectiveModel = model || modelOption?.currentValue || "";
  const selectedModel = modelOption?.values.find((candidate) => candidate.value === effectiveModel);
  const modelLabel = selectedModel?.name || selectedModel?.value || (modelOption ? defaultModelLabel(modelOption) : "Agent 默认");
  return <Popover>
    <PopoverTrigger asChild>
      <Button aria-label="Model and reasoning" className="h-8 max-w-52 gap-1.5 px-2 text-xs" title={modelLabel} variant="ghost">
        <span className="truncate">{modelLabel}</span><ChevronDown className="size-3 opacity-60" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="grid w-80 gap-4 border-line-strong text-ink-soft shadow-panel" side="top" surface="frosted">
      {modelOption && <ControlGroup label="Model">
        <SessionConfigSelect ariaLabel={modelOption.name} label={defaultModelLabel(modelOption)} onValue={onModel} option={modelOption} value={model} wide />
      </ControlGroup>}
      {thoughtLevelOption && <ReasoningLevelControl onValue={onEffort} option={thoughtLevelOption} value={effort} />}
      {speedOption && <ControlGroup label="速度">
        <SpeedControl
          onValue={(value) => onConfigOverride(speedOption, value)}
          option={speedOption}
          overridden={Object.hasOwn(configOverrides, speedOption.id)}
          value={String(configOverrides[speedOption.id] ?? speedOption.currentValue ?? "false")}
        />
      </ControlGroup>}
    </PopoverContent>
  </Popover>;
}

function ControlGroup({ children, label }: { children: ReactNode; label: string }) {
  return <div className="grid gap-1.5">
    <span className="text-xs font-medium text-ink">{label}</span>
    {children}
  </div>;
}

function ReasoningLevelControl({ onValue, option, value }: {
  onValue: (value: string) => void;
  option: ConfigOption;
  value: string;
}) {
  const selectableLevels = option.values.filter((candidate) => candidate.value.toLowerCase() !== "default");
  const levels = selectableLevels.length ? selectableLevels : option.values;
  if (!levels.length) return null;
  const effectiveValue = value || option.currentValue || levels[0]!.value;
  const committedIndex = Math.max(0, levels.findIndex((candidate) => candidate.value === effectiveValue));
  return <ReasoningLevelSlider
    committedIndex={committedIndex}
    key={effectiveValue}
    levels={levels}
    onValue={onValue}
    value={value}
  />;
}

function ReasoningLevelSlider({ committedIndex, levels, onValue, value }: {
  committedIndex: number;
  levels: ConfigOption["values"];
  onValue: (value: string) => void;
  value: string;
}) {
  const [previewIndex, setPreviewIndex] = useState(committedIndex);
  const active = levels[previewIndex] ?? levels[0]!;
  return <div className="grid gap-3">
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs font-medium text-ink">推理强度</span>
      <span className="flex min-w-0 items-center gap-2">
        {value && <button className="text-xs text-muted underline underline-offset-2" onClick={() => onValue("")} type="button">恢复默认</button>}
        <span className="truncate text-xs text-muted">{active.name || active.value}</span>
      </span>
    </div>
    <div className="relative py-1">
      <div className="pointer-events-none absolute inset-x-1 top-1/2 flex -translate-y-1/2 justify-between">
        {levels.map((level, index) => <span
          className={cn(
            "size-1 rounded-full bg-current motion-safe:transition-[color,transform] motion-safe:duration-150",
            previewIndex >= index ? "text-control-accent" : "text-faint",
            previewIndex === index && "scale-150",
          )}
          key={`${level.value}-${index}`}
        />)}
      </div>
      <Slider
        aria-label="Reasoning level"
        className="text-control-accent"
        max={levels.length - 1}
        min={0}
        onValueChange={([index]) => setPreviewIndex(index ?? 0)}
        onValueCommit={([index]) => onValue(levels[index ?? 0]?.value ?? "")}
        step={1}
        value={[previewIndex]}
      />
    </div>
    <div className="flex justify-between text-xs text-faint"><span>{levels[0]?.name}</span><span>{levels.at(-1)?.name}</span></div>
    <p className="min-h-4 text-xs leading-4 text-muted">{active.description ?? "Agent 提供的推理等级"}</p>
  </div>;
}

function SpeedControl({ onValue, option, overridden, value }: {
  onValue: (value: string) => void;
  option: ConfigOption;
  overridden: boolean;
  value: string;
}) {
  const selected = option.values.find((candidate) => candidate.value === value);
  const label = speedValueLabel(selected?.value ?? value, selected?.name);
  return <Select onValueChange={(next) => onValue(next === DEFAULT_SELECT_VALUE ? "" : next)} value={overridden ? value : DEFAULT_SELECT_VALUE}>
    <SelectTrigger aria-label="速度" className="h-8 w-full border-line bg-surface-soft px-2 py-0 text-xs text-ink-soft shadow-none focus-visible:ring-1">
      <Gauge className="size-3" /><SelectValue>{label}</SelectValue>
    </SelectTrigger>
    <SelectContent className="max-w-80 border-line-strong text-ink-soft shadow-panel" surface="frosted">
      <SelectItem className="data-[highlighted]:bg-surface-soft" value={DEFAULT_SELECT_VALUE}>跟随默认（{speedValueLabel(option.currentValue ?? "false")}）</SelectItem>
      {option.values.map((candidate) => <SelectItem className="data-[highlighted]:bg-surface-soft" key={candidate.value} textValue={speedValueLabel(candidate.value, candidate.name)} value={candidate.value}>
        <span className="grid gap-0.5 py-0.5">
          <span>{speedValueLabel(candidate.value, candidate.name)}</span>
          <span className="max-w-72 text-xs font-normal leading-4 text-muted">{candidate.description ?? (speedValueLabel(candidate.value, candidate.name) === "快速" ? "响应更快，配额消耗更高" : "标准响应速度")}</span>
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}

function SessionConfigSelect({ ariaLabel, label, onValue, option, value, wide = false }: {
  ariaLabel: string;
  label: string;
  onValue: (value: string) => void;
  option: ConfigOption;
  value: string;
  wide?: boolean;
}) {
  const effective = value || option.currentValue || "";
  const selected = option.values.find((candidate) => candidate.value === effective);
  const triggerLabel = selected ? selected.name || selected.value : label;
  return <Select onValueChange={(next) => onValue(next === DEFAULT_SELECT_VALUE ? "" : next)} value={effective || DEFAULT_SELECT_VALUE}>
    <SelectTrigger
      aria-label={ariaLabel}
      className={cn(
        "h-8 gap-1 border-line bg-surface-soft px-2 py-0 text-xs shadow-none focus-visible:ring-1",
        wide ? "w-full" : "max-w-44",
        value ? "text-ink-soft" : "text-muted",
      )}
      title={selected?.description}
    >
      <SelectValue>{triggerLabel}</SelectValue>
    </SelectTrigger>
    <SelectContent className="max-w-80 border-line-strong text-ink-soft shadow-panel" surface="frosted">
      {!selected && <SelectItem className="data-[highlighted]:bg-surface-soft" value={DEFAULT_SELECT_VALUE}>{label}</SelectItem>}
      {option.values.map((candidate) => <SelectItem className="data-[highlighted]:bg-surface-soft" key={candidate.value} textValue={candidate.name || candidate.value} value={candidate.value}>
        <span className="grid gap-0.5 py-0.5">
          <span>{candidate.name || candidate.value}</span>
          {candidate.description && <span className="max-w-72 text-xs font-normal leading-4 text-muted">{candidate.description}</span>}
        </span>
      </SelectItem>)}
    </SelectContent>
  </Select>;
}
