import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, FileText, FolderOpen, LoaderCircle, Send, Square } from "lucide-react";
import { ComposerAttachments } from "@/components/composer-attachments";
import { ComposerActions, ModelControls, PermissionControl } from "@/components/composer-controls";
import {
  MarkdownComposer,
  type ComposerPickerKey,
  type ComposerTrigger,
} from "@/components/markdown-composer/markdown-composer";
import { Button } from "@/components/ui/button";
import type {
  AgentCommand,
  AgentSession,
  ConfigOption,
  FlowRecord,
  MessageAttachmentInput,
  WorkspaceListing,
} from "@/lib/types";
import {
  applyComposerSuggestion,
  composerTrigger,
  filterCommands,
  workspacePaths,
} from "@/lib/workbench-logic";
import { cn } from "@/lib/utils";

type ComposerProps = {
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
};

export function Composer({
  attachments,
  commands,
  contextOpen,
  workspaceListing,
  workspaceLoading,
  disabled,
  draft,
  flowId,
  flows,
  model,
  modelOption,
  effort,
  thoughtLevelOption,
  configOverrides,
  speedOption,
  permissionMode,
  permissionOption,
  sending,
  session,
  commandOpen,
  running,
  onAddFiles,
  onCommandOpen,
  onContext,
  onContextNavigate,
  onContextOpen,
  onDraft,
  onFiles,
  onFlow,
  onModel,
  onEffort,
  onConfigOverride,
  onPermissionMode,
  onPickDirectory,
  onRemoveAttachment,
  onSubmit,
  onStop,
}: ComposerProps) {
  const trigger = composerTrigger(draft);
  const commandQuery = trigger?.kind === "command" ? trigger.query : "";
  const visibleCommands = filterCommands(commands, commandQuery);
  const contextQuery = trigger?.kind === "context" ? trigger.query.toLowerCase() : "";
  const visibleEntries = (workspaceListing?.entries ?? []).filter(
    (entry) => !contextQuery || `${entry.name} ${entry.path}`.toLowerCase().includes(contextQuery),
  );
  const hasWorkspace = workspacePaths(session).length > 0;
  const [commandIndex, setCommandIndex] = useState(0);
  const [contextIndex, setContextIndex] = useState(0);
  const [serializationError, setSerializationError] = useState<string | null>(null);
  const [sweepKey, setSweepKey] = useState(0);

  useEffect(() => setCommandIndex(0), [commandOpen, commandQuery]);
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
    if (entry.kind === "directory") {
      onContextNavigate(entry.path, workspaceListing?.root);
      return;
    }
    onContext(entry.absolutePath);
    onContextOpen(false);
  }

  function handlePickerKey(event: ComposerPickerKey): boolean {
    if (event.key === "Escape" && (commandOpen || contextOpen)) {
      onCommandOpen(false);
      onContextOpen(false);
      return true;
    }
    if (commandOpen && visibleCommands.length > 0) {
      if (event.key === "ArrowDown") {
        setCommandIndex((index) => (index + 1) % visibleCommands.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setCommandIndex((index) => (index - 1 + visibleCommands.length) % visibleCommands.length);
        return true;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        pickCommand(commandIndex);
        return true;
      }
    }
    if (contextOpen && visibleEntries.length > 0) {
      if (event.key === "ArrowDown") {
        setContextIndex((index) => (index + 1) % visibleEntries.length);
        return true;
      }
      if (event.key === "ArrowUp") {
        setContextIndex((index) => (index - 1 + visibleEntries.length) % visibleEntries.length);
        return true;
      }
      if (event.key === "Tab" || (event.key === "Enter" && visibleEntries[contextIndex]?.kind !== "directory")) {
        pickEntry(contextIndex);
        return true;
      }
    }
    return false;
  }

  function handleTrigger(next: ComposerTrigger) {
    onCommandOpen(next?.kind === "command" && commands.length > 0);
    onContextOpen(next?.kind === "context" && hasWorkspace);
  }

  function openWorkspaceContext() {
    const separator = draft && !/\s$/.test(draft) ? " " : "";
    onDraft(`${draft}${separator}@`);
    onContextOpen(true);
  }

  function submitWithSweep() {
    if (disabled || sending || !draft.trim() || serializationError) return;
    setSweepKey((value) => value + 1);
    onSubmit();
  }

  return <div
    className={cn(
      "relative rounded-xl border border-line-strong bg-surface shadow-panel",
      running && "motion-safe:animate-breathe",
    )}
    data-composer
    data-composer-running={running || undefined}
  >
    <ComposerAttachments attachments={attachments} onRemove={onRemoveAttachment} />
    <MarkdownComposer
      disabled={disabled || sending}
      onChange={onDraft}
      onFiles={(files) => onAddFiles(files)}
      onPickerKey={handlePickerKey}
      onSerializationError={setSerializationError}
      onSubmit={submitWithSweep}
      onTrigger={handleTrigger}
      value={draft}
    />
    <div className="flex items-end justify-between gap-3 px-3 pb-2.5">
      <div className="flex items-center gap-1">
        <ComposerActions
          flowId={flowId}
          flows={flows}
          hasWorkspace={hasWorkspace}
          onFiles={onFiles}
          onFlow={onFlow}
          onPickDirectory={onPickDirectory}
          onWorkspaceContext={openWorkspaceContext}
        />
        <PermissionControl onValue={onPermissionMode} option={permissionOption} value={permissionMode} />
      </div>
      <div className="flex items-center gap-1.5">
        <ModelControls
          configOverrides={configOverrides}
          effort={effort}
          model={model}
          modelOption={modelOption}
          onConfigOverride={onConfigOverride}
          onEffort={onEffort}
          onModel={onModel}
          speedOption={speedOption}
          thoughtLevelOption={thoughtLevelOption}
        />
        {running && <Button
          aria-label="停止当前 Run"
          className="size-8 bg-danger-soft px-0 text-danger"
          onClick={onStop}
          size="icon"
          title="停止当前 Run"
        >
          <Square className="size-3.5 fill-current" />
        </Button>}
        <Button
          aria-label="发送"
          className="size-8 bg-accent px-0 text-accent-ink transition-transform active:translate-y-px"
          disabled={disabled || sending || !draft.trim() || Boolean(serializationError)}
          onClick={submitWithSweep}
          size="icon"
        >
          {sending ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
      </div>
    </div>
    {serializationError && <p className="px-3 pb-2 text-xs text-danger" role="alert">{serializationError}</p>}
    {contextOpen && hasWorkspace && <ContextPicker
      activeIndex={contextIndex}
      entries={visibleEntries}
      listing={workspaceListing}
      loading={workspaceLoading}
      onNavigate={onContextNavigate}
      onPick={pickEntry}
      onSelect={setContextIndex}
    />}
    {commandOpen && visibleCommands.length > 0 && <CommandPicker
      activeIndex={commandIndex}
      commands={visibleCommands}
      onPick={pickCommand}
      onSelect={setCommandIndex}
    />}
    {sweepKey > 0 && <span aria-hidden="true" className="composer-sweep sent" key={sweepKey} />}
  </div>;
}

function ContextPicker({ activeIndex, entries, listing, loading, onNavigate, onPick, onSelect }: {
  activeIndex: number;
  entries: WorkspaceListing["entries"];
  listing: WorkspaceListing | null;
  loading: boolean;
  onNavigate: (path: string, root?: string) => void;
  onPick: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return <div className="absolute bottom-[calc(100%+0.5rem)] left-3 z-30 w-[420px] overflow-hidden rounded-lg border border-line-strong bg-surface shadow-panel">
    <div className="flex h-9 items-center gap-2 border-b border-line px-2.5 text-xs text-muted">
      {listing?.relativePath && <button
        aria-label="返回上级目录"
        className="grid size-6 place-items-center rounded-md hover:opacity-70"
        onClick={() => onNavigate(listing.relativePath!.split("/").slice(0, -1).join("/"), listing.root)}
        type="button"
      >
        <ChevronDown className="size-3.5 rotate-90" />
      </button>}
      <FolderOpen className="size-3.5" />
      <span className="min-w-0 flex-1 truncate font-mono">{listing?.path}</span>
    </div>
    <div className="max-h-72 overflow-y-auto p-1">
      {loading
        ? <div className="px-3 py-6 text-center text-xs text-muted">正在读取 Workspace…</div>
        : entries.length
          ? entries.map((entry, index) => <button
            aria-selected={index === activeIndex}
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-xs text-ink hover:opacity-80",
              index === activeIndex && "bg-surface-soft",
            )}
            key={entry.absolutePath}
            onClick={() => onPick(index)}
            onMouseEnter={() => onSelect(index)}
            ref={index === activeIndex ? (node) => node?.scrollIntoView?.({ block: "nearest" }) : undefined}
            type="button"
          >
            {entry.kind === "directory"
              ? <FolderOpen className="size-3.5 shrink-0 text-muted" />
              : <FileText className="size-3.5 shrink-0 text-muted" />}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            <span className="max-w-48 truncate font-mono text-xs text-faint">{entry.absolutePath}</span>
            {entry.kind === "directory" && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
          </button>)
          : <div className="px-3 py-6 text-center text-xs text-muted">没有匹配的文件或目录</div>}
    </div>
  </div>;
}

function CommandPicker({ activeIndex, commands, onPick, onSelect }: {
  activeIndex: number;
  commands: AgentCommand[];
  onPick: (index: number) => void;
  onSelect: (index: number) => void;
}) {
  return <div className="absolute bottom-[calc(100%+0.5rem)] left-3 z-30 max-h-72 w-[420px] overflow-y-auto rounded-lg border border-line-strong bg-surface p-1 shadow-panel">
    {commands.map((command, index) => <button
      aria-selected={index === activeIndex}
      className={cn(
        "grid w-full gap-0.5 rounded-md px-3 py-2.5 text-left text-ink hover:opacity-80",
        index === activeIndex && "bg-surface-soft",
      )}
      key={command.name}
      onClick={() => onPick(index)}
      onMouseEnter={() => onSelect(index)}
      ref={index === activeIndex ? (node) => node?.scrollIntoView?.({ block: "nearest" }) : undefined}
      type="button"
    >
      <span className="font-mono text-xs">/{command.name}</span>
      <span className="truncate text-xs text-muted">{command.description}</span>
    </button>)}
  </div>;
}
