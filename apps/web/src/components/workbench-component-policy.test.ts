import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** The workbench component tree, concatenated: policy assertions apply to the whole surface. */
function readSource(): string {
  return [
    "./workbench.tsx",
    "./composer.tsx",
    "./composer-attachments.tsx",
    "./composer-controls.tsx",
    "./markdown-composer/markdown-composer.tsx",
    "./conversation.tsx",
    "./session-chrome.tsx",
    "./session-timeline.tsx",
    "./command-palette.tsx",
  ]
    .map((file) => readFileSync(new URL(file, import.meta.url), "utf8"))
    .join("\n");
}

// Enforces spec rules FE-TOKEN-005, FE-COMP-001, FE-COMP-002, FE-COMP-003,
// FE-STATE-001, FE-STATE-002, FE-STATE-003 (docs/spec/RULES.md).
describe("Workbench component policy", () => {
  it("uses the shadcn Select primitive instead of native select controls", () => {
    const source = readSource();

    expect(source).toContain('from "@/components/ui/select"');
    expect(source).not.toMatch(/<select\b/);
  });

  it("consumes semantic design tokens instead of hardcoded palette colors", () => {
    const files = [
      "./workbench.tsx",
      "./composer.tsx",
      "./composer-attachments.tsx",
      "./composer-controls.tsx",
      "./markdown-composer/markdown-composer.tsx",
      "./design-preview.tsx",
      "./ui/button.tsx",
      "./ui/textarea.tsx",
      "./ui/badge.tsx",
      "./ui/slider.tsx",
      "./ui/select.tsx",
      "./ui/popover.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, import.meta.url), "utf8");

      expect(source, file).not.toMatch(/#[0-9A-Fa-f]{6}/);
      expect(source, file).not.toMatch(/(?:bg|text|border|ring)-(?:zinc|slate|gray|neutral|stone|red|amber|emerald|blue|indigo|purple)-\d/);
    }
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(workbench).not.toContain("const themes = {");
    expect(workbench).toContain('data-theme={theme}');
    const styles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(styles).toContain('[data-theme="carbon"]');
    expect(styles).toContain("--color-surface: var(--agnet-surface)");
  });

  it("mounts Skill management as a first-class workbench surface", () => {
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
    const rail = readFileSync(new URL("./session-chrome.tsx", import.meta.url), "utf8");

    expect(workbench).toContain('import { SkillControlPlanePage } from "@/components/skill-control-plane"');
    expect(workbench).toContain('area === "skills"');
    expect(workbench).toContain("<SkillControlPlanePage onNotify={notify} />");
    expect(rail).toContain('onArea("skills")');
  });

  it("renders working activity separately from final Agent messages", () => {
    const source = readSource();

    expect(source).toContain("function WorkActivity");
    expect(source).toContain("function ToolActivity");
    expect(source).toContain("<WorkMarkdown content={entry.content}");
    expect(source).toContain('"group w-full max-w-[780px] border-t"');
    expect(source).toContain('"relative grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-2 overflow-hidden pb-4"');
    expect(source).toContain('"grid w-full min-w-0 max-w-full grid-cols-[21px_minmax(0,1fr)] gap-2 overflow-hidden px-1 py-1"');
    expect(source).toContain('"max-w-full break-words text-xs font-normal leading-5"');
    expect(source).not.toContain("Agent · working");
  });

  it("places command and context suggestions outside the composer input surface", () => {
    const source = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");

    expect(source).toContain("function CommandPicker");
    expect(source).toContain("function ContextPicker");
    expect(source).toContain("bottom-[calc(100%+0.5rem)]");
    expect(source).not.toContain('aria-label="Agent commands"');
    expect(source).not.toContain('aria-label="插入上下文"');
  });

  it("renders math and Mermaid diagrams as rich conversation content", () => {
    const source = readSource();
    const mermaidUrl = new URL("./mermaid-diagram.tsx", import.meta.url);

    expect(existsSync(mermaidUrl)).toBe(true);
    if (!existsSync(mermaidUrl)) return;
    const mermaid = readFileSync(mermaidUrl, "utf8");
    expect(source).toContain('import remarkMath from "remark-math"');
    expect(source).toContain('import rehypeKatex from "rehype-katex"');
    expect(source).toContain('import "katex/dist/katex.min.css"');
    expect(source).toContain('className?.includes("language-mermaid")');
    expect(source).toContain("<MermaidDiagram");
    expect(mermaid).toContain('await import("mermaid")');
    expect(mermaid).toContain('aria-label="Mermaid diagram"');
  });

  it("keeps rendered Markdown mounted while unrelated Session controls change", () => {
    const source = readSource();

    expect(source).toContain("const Markdown = memo(function Markdown");
  });

  it("renders conversation tables as framed rows instead of a full grid", () => {
    const source = readFileSync(new URL("./conversation.tsx", import.meta.url), "utf8");

    expect(source).toContain("function MarkdownTable");
    expect(source).toContain("rounded-lg border");
    expect(source).toContain("[&_tbody_tr:not(:last-child)_td]:border-b");
    expect(source).not.toContain("[&_td]:border-b [&_td]:p-2 [&_th]:border-b");
  });

  it("keeps Agent-native model, reasoning, and permission controls in the Composer", () => {
    const source = readSource();
    const controls = readFileSync(new URL("./composer-controls.tsx", import.meta.url), "utf8");
    const sliderUrl = new URL("./ui/slider.tsx", import.meta.url);

    expect(source).toContain("permissionOption={permissionOption}");
    expect(source).toContain("thoughtLevelOption={thoughtLevelOption}");
    expect(source).toContain("onPermissionMode={setSessionPermissionMode}");
    expect(source).toContain("onEffort={setSessionEffort}");
    expect(controls).toContain("<ReasoningLevelControl");
    expect(source).toContain("speedOption={speedOption}");
    expect(controls).toContain("<SpeedControl");
    expect(existsSync(sliderUrl)).toBe(true);
    expect(controls).toContain("const effectiveValue = value || option.currentValue");
    expect(controls).toContain('onClick={() => onValue("")}');
    expect(controls).toContain('label="Agent 默认"');
    expect(controls).toContain("<SelectValue>{triggerLabel}</SelectValue>");
    expect(source).toContain('runState === "running" ? "bg-success" : "bg-warning"');
    expect(source).toContain("runState !== \"idle\"");
  });

  it("uses reduced-motion-safe feedback for the discrete reasoning slider", () => {
    const source = readFileSync(new URL("./composer-controls.tsx", import.meta.url), "utf8");
    const slider = readFileSync(new URL("./ui/slider.tsx", import.meta.url), "utf8");

    expect(source).toContain("previewIndex >= index");
    expect(source).toContain("active.description");
    expect(slider).toContain("motion-safe:transition-[left,transform,box-shadow]");
    expect(slider).toContain("motion-safe:transition-[width]");
  });

  it("uses the open pixel typography and AGNET product mark", () => {
    // FE-TYPE-001
    const source = readSource();
    const mark = readFileSync(new URL("./pixel-mark.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(source).toContain('import { PixelMark } from "@/components/pixel-mark"');
    expect(source).toContain("<PixelMark");
    expect(mark).toContain("shapeRendering=\"crispEdges\"");
    expect(styles).toContain("Departure Mono");
    expect(styles).toContain("Commit Mono");
    expect(source).toContain('<h1 className={cn("font-brand text-2xl font-normal leading-none tracking-normal", "text-ink")}>');
    expect(source).not.toContain('<GitBranch className="size-4"');
  });

  it("publishes the product mark as the browser icon", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");
    const mark = new URL("../../public/brand/agnet-mark.svg", import.meta.url);

    expect(existsSync(mark)).toBe(true);
    expect(html).toContain('rel="icon"');
    expect(html).toContain("/workbench/brand/agnet-mark.svg");
    expect(html).toContain("AGNET · CodeBridge Workbench");
  });

  it("keeps page-level titles on the brand display font", () => {
    // FE-TYPE-001: settings page title matches the panel title role
    const settings = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");

    expect(settings).toContain('font-brand text-lg font-normal tracking-[-0.035em]');
    const styles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(styles).toContain('"PingFang SC"');
  });

  it("keeps eyebrow labels and card titles on the canonical type roles", () => {
    // FE-TYPE-003
    const source = readSource();

    expect(source).not.toMatch(/text-xs font-semibold uppercase/);
    expect(source).not.toMatch(/text-xs font-medium uppercase/);
    expect(source).toContain("font-brand text-xs font-normal uppercase tracking-[0.1em]");
  });

  it("locks the document viewport so the Agent Rail cannot scroll out of view", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

    expect(html).toContain('<body class="h-full overflow-hidden bg-canvas text-ink antialiased">');
    expect(html).toContain("document.documentElement.dataset.theme = theme");
  });

  it("positions a loaded Session at the newest conversation item", () => {
    const source = readSource();

    expect(source).toContain("viewport.scrollTop = viewport.scrollHeight");
    expect(source).toContain("stuckToBottom");
    expect(source).toContain("[sessionView, selectedSessionId, loadingSession, stuckToBottom]");
    expect(source).toContain("if (!sessionSwitch.current && !stuckToBottom) return");
    expect(source).toContain("requestAnimationFrame");
  });

  it("selects the external Store view by Session id so projections cannot leak across Sessions", () => {
    const source = readSource();

    expect(source).toContain("useSessionView(selectedSessionId)");
    expect(source).not.toContain("setEvents(");
  });

  it("does not block the first paint on provider Session import", () => {
    const source = readSource();

    expect(source).toContain("void reload(false).then(() => void reload(true, true));");
    expect(source).toContain("async (importProvider = false, silent = false)");
  });

  it("opens live work and keeps reasoning headings lighter than answer headings", () => {
    const source = readSource();

    expect(source).toContain("<details open={running || undefined}");
    expect(source).toContain('h1: ({ children }) => <h1 className="mb-1 text-xs font-medium leading-5"');
    expect(source).toContain('h2: ({ children }) => <h2 className="mb-1 text-xs font-medium leading-5"');
    expect(source).toContain('h3: ({ children }) => <h3 className="mb-1 text-xs font-medium leading-5"');
  });

  it("shows the Agent identity when an existing Session has no messages", () => {
    const source = readSource();

    expect(source).toContain('aria-label="Empty Session"');
    expect(source).toContain("selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id}");
    expect(source).toContain("selectedSession.title || (selectedAgent ? `${selectedAgent.display_name} Session` : \"Session\")");
  });

  it("aligns work entries and normalizes semantic icon frames", () => {
    const source = readSource();

    expect(source).toContain('"flex cursor-pointer list-none items-center gap-2 py-3 text-xs"');
    expect(source).not.toContain('"flex cursor-pointer list-none items-center gap-2 py-3 pl-6 text-xs"');
    expect(source).toContain('"bg-line"');
    expect(source).toContain("LiveElapsed");
    expect(source).toContain('"grid size-4 shrink-0 place-items-center"');
    expect(source).toContain("<PixelMark");
    expect(source).toContain("<BrandAgentIcon");
  });

  it("never silently swallows a send: existing sessions submit regardless of stale Agent status, blocked sends explain why", () => {
    const source = readSource();

    // The old guard `selectedAgent.status !== "healthy"` dropped the click
    // with no feedback when the cached agent profile was stale.
    expect(source).not.toContain('if (!message || sending || !selectedAgent || selectedAgent.status !== "healthy") return;');
    expect(source).toContain("请先在设置中完成安装/配置");
  });

  it("reads Session state from the external Store and revalidates through the connection", () => {
    const source = readSource();

    expect(source).toContain("useSessionView(selectedSessionId)");
    expect(source).toContain("sessionConnection.open(sessionId)");
    expect(source).not.toContain("sessionCache");
  });

  it("resets composer config when switching Agents without a session change", () => {
    const source = readSource();

    expect(source).toContain("if (nextSessionId === selectedSessionId && agentId !== selectedAgentId)");
    expect(source).toContain("setConfigOptions([])");
  });

  it("checks the resolved default model instead of a duplicate Agent-default item", () => {
    const source = readFileSync(new URL("./composer-controls.tsx", import.meta.url), "utf8");

    expect(source).toContain('const effective = value || option.currentValue || "";');
    expect(source).toContain("{!selected && <SelectItem");
  });

  it("uses the approved minimal rich Composer without removing capabilities", () => {
    const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
    const editor = readFileSync(new URL("./markdown-composer/markdown-composer.tsx", import.meta.url), "utf8");
    const controls = readFileSync(new URL("./composer-controls.tsx", import.meta.url), "utf8");

    expect(composer).toContain("<ComposerAttachments");
    expect(composer).toContain("<MarkdownComposer");
    expect(composer).toContain("<ComposerActions");
    expect(composer).toContain("<PermissionControl");
    expect(composer).toContain("<ModelControls");
    expect(composer).toContain('aria-label="停止当前 Run"');
    expect(composer).toContain('aria-label="发送"');
    expect(composer).not.toContain("<Textarea");
    expect(composer).not.toContain("Enter 发送");
    expect(editor).toContain('name: "composerEvents"');
    expect(editor).toContain("onFiles");
    expect(editor).toContain("onPickerKey");
    expect(controls).toContain("添加文件");
    expect(controls).toContain("Workspace");
    expect(controls).toContain("Flow");
    expect(controls).toContain("<ReasoningLevelControl");
    expect(controls).toContain("<SpeedControl");
  });

  it("keeps glass local to the Composer and floating interaction surfaces", () => {
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
    const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
    const controls = readFileSync(new URL("./composer-controls.tsx", import.meta.url), "utf8");
    const palette = readFileSync(new URL("./command-palette.tsx", import.meta.url), "utf8");
    const popover = readFileSync(new URL("./ui/popover.tsx", import.meta.url), "utf8");
    const select = readFileSync(new URL("./ui/select.tsx", import.meta.url), "utf8");

    expect(popover).toContain('surface?: "solid" | "frosted"');
    expect(select).toContain('surface?: "solid" | "frosted"');
    expect(controls).toContain('surface="frosted"');
    expect(`${composer}\n${palette}`).toContain("surface-frosted");
    expect(workbench).not.toContain("surface-frosted");
    expect(workbench).not.toContain("backdrop-blur");
  });

  it("reveals only newly live Assistant segments and respects reduced motion", () => {
    const timeline = readFileSync(new URL("./session-timeline.tsx", import.meta.url), "utf8");
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../index.css", import.meta.url), "utf8");

    expect(timeline).toContain("seenSegmentIds");
    expect(timeline).toContain("newlyLiveAssistantSegments");
    expect(timeline).toContain("data-streaming-caret");
    expect(workbench).toContain("key={selectedSessionId}");
    expect(styles).toContain(".assistant-reveal");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("keeps successful attachments when another selected file cannot be read", () => {
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(workbench).toContain("Promise.allSettled");
    expect(workbench).toContain("if (successful.length) setAttachments");
    expect(workbench).toContain("if (failed) setError(messageOf(failed.reason))");
  });

  it("submits a message atomically and resolves uncertain outcomes before changing authority", () => {
    const source = readSource();

    expect(source).toContain("submitSessionMessage({");
    expect(source).toContain("pendingSubmissionKey.current");
    expect(source).not.toContain("api.startRun");
    expect(source).not.toContain("mergeConversationEvents");
  });

  it("offers per-Session management from each Session row", () => {
    const source = readSource();

    expect(source).toContain("function SessionRow");
    expect(source).toContain("aria-label={`管理 ${title}`}");
    expect(source).toContain("onUpdateSession");
    expect(source).toContain("重命名");
    expect(source).toContain("归档");
    expect(source).toContain("删除");
    expect(source).toContain("function useDismissOnOutside");
    expect(source).toContain('document.addEventListener("pointerdown"');
  });

  it("loads Agent-native commands for Web slash suggestions", () => {
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(workbench).toContain("api.commands(");
    expect(workbench).toContain("setCommandOpen(nextTrigger?.kind === \"command\")");
  });

  it("closes Provider Session history import through explicit Preview and confirmation", () => {
    const workbench = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
    const client = readFileSync(new URL("../lib/api.ts", import.meta.url), "utf8");
    const openSessionSource = client.slice(
      client.indexOf("async function openSession"),
      client.indexOf("async function importSessions"),
    );

    expect(workbench).toContain("ProviderHistoryImportCard,");
    expect(workbench).toContain('from "@/components/provider-history-import-card"');
    expect(workbench).toContain("api.previewProviderHistory(");
    expect(workbench).toContain("api.importProviderHistory(");
    expect(workbench).toContain("pendingHistoryImportKey");
    expect(workbench).toContain("providerHistoryRequestVersion");
    expect(workbench).toContain("sessionViewStore.hydrate(snapshot)");
    expect(workbench).not.toContain("setEvents(");

    expect(client).toContain('request<SessionSnapshot>(\'/v1/sessions/\' + encodeURIComponent(id))');
    expect(client).toContain("async function openSession(id: string)");
    expect(openSessionSource).not.toContain("provider-history");
    expect(openSessionSource).not.toContain('method: "POST"');
  });
});
