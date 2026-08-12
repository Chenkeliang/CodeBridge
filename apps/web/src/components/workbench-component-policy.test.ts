import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Workbench component policy", () => {
  it("uses the shadcn Select primitive instead of native select controls", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain('from "@/components/ui/select"');
    expect(source).not.toMatch(/<select\b/);
  });

  it("consumes semantic design tokens instead of hardcoded palette colors", () => {
    const files = ["./workbench.tsx", "./design-preview.tsx", "./ui/button.tsx", "./ui/textarea.tsx", "./ui/badge.tsx", "./ui/slider.tsx", "./ui/select.tsx", "./ui/popover.tsx"];
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

  it("renders working activity separately from final Agent messages", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("function WorkActivity");
    expect(source).toContain("function ToolActivity");
    expect(source).toContain("<WorkMarkdown content={entry.content}");
    expect(source).toContain('"group w-full max-w-[780px] border-t"');
    expect(source).toContain('"grid w-full min-w-0 max-w-full grid-cols-[minmax(0,1fr)] gap-2 overflow-hidden pb-4"');
    expect(source).toContain('"grid w-full min-w-0 max-w-full grid-cols-[18px_minmax(0,1fr)] gap-2 overflow-hidden px-1 py-1"');
    expect(source).toContain('"max-w-full break-words text-xs font-normal leading-5"');
    expect(source).not.toContain("Agent · working");
  });

  it("places command and context suggestions outside the composer input surface", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain('"absolute bottom-[calc(100%+0.5rem)] left-3 z-30');
    expect(source).toContain('"absolute bottom-[calc(100%+0.5rem)] left-12 z-30');
    expect(source).toContain('<div className="flex items-center gap-1">');
    expect(source).not.toContain('<div className="relative flex items-center gap-1">');
  });

  it("renders math and Mermaid diagrams as rich conversation content", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
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
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("const Markdown = memo(function Markdown");
  });

  it("keeps Agent-native model, reasoning, and permission controls in the Composer", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
    const sliderUrl = new URL("./ui/slider.tsx", import.meta.url);

    expect(source).toContain("permissionOption={permissionOption}");
    expect(source).toContain("thoughtLevelOption={thoughtLevelOption}");
    expect(source).toContain("onPermissionMode={setSessionPermissionMode}");
    expect(source).toContain("onEffort={setSessionEffort}");
    expect(source).toContain("<ReasoningLevelControl");
    expect(source).toContain("speedOption={speedOption}");
    expect(source).toContain("<SpeedControl");
    expect(existsSync(sliderUrl)).toBe(true);
    expect(source).toContain('const effectiveValue = value || option.currentValue || levels[0]?.value || ""');
    expect(source).toContain('onClick={() => onValue("")}>Use default</button>');
    expect(source).toContain('label="Agent default"');
    expect(source).toContain("<SelectValue>{triggerLabel}</SelectValue>");
    expect(source).toContain('session.status === "active" || session.status === "idle" ? "bg-success" : "bg-faint"');
  });

  it("uses reduced-motion-safe feedback for the discrete reasoning slider", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
    const slider = readFileSync(new URL("./ui/slider.tsx", import.meta.url), "utf8");

    expect(source).toContain("previewIndex >= index");
    expect(source).toContain("active.description");
    expect(slider).toContain("motion-safe:transition-[left,transform,box-shadow]");
    expect(slider).toContain("motion-safe:transition-[width]");
  });

  it("uses the open pixel typography and AGNET product mark", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");
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

  it("locks the document viewport so the Agent Rail cannot scroll out of view", () => {
    const html = readFileSync(new URL("../../index.html", import.meta.url), "utf8");

    expect(html).toContain('<body class="h-full overflow-hidden bg-canvas text-ink antialiased">');
    expect(html).toContain("document.documentElement.dataset.theme = theme");
  });

  it("positions a loaded Session at the newest conversation item", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("conversationViewport.current.scrollTop = conversationViewport.current.scrollHeight");
    expect(source).toContain("[events, selectedSessionId, loadingSession, sending]");
    expect(source).toContain("requestAnimationFrame");
  });

  it("clears the previous Session projection before hydrating the next one", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("setEvents(pendingEvents.current[sessionId] ?? [])");
  });

  it("does not block the first paint on provider Session import", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("void reload(false).then(() => void reload(true, true));");
    expect(source).toContain("async (importProvider = false, silent = false)");
  });

  it("opens live work and keeps reasoning headings lighter than answer headings", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("<details open={running || undefined}");
    expect(source).toContain('h1: ({ children }) => <h1 className="mb-1 text-xs font-medium leading-5"');
    expect(source).toContain('h2: ({ children }) => <h2 className="mb-1 text-xs font-medium leading-5"');
    expect(source).toContain('h3: ({ children }) => <h3 className="mb-1 text-xs font-medium leading-5"');
  });

  it("shows the Agent identity when an existing Session has no messages", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain('aria-label="Empty Session"');
    expect(source).toContain("selectedAgent ? <BrandAgentIcon agentId={selectedAgent.agent_id}");
    expect(source).toContain("selectedSession.title || (selectedAgent ? `${selectedAgent.display_name} Session` : \"Session\")");
  });

  it("aligns work entries and normalizes semantic icon frames", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain('"flex cursor-pointer list-none items-center gap-2 py-3 text-[11px]"');
    expect(source).not.toContain('"flex cursor-pointer list-none items-center gap-2 py-3 pl-6 text-[11px]"');
    expect(source).toContain('"w-full min-w-0 max-w-full pl-6"');
    expect(source).toContain('"grid size-4 shrink-0 place-items-center"');
    expect(source).toContain("<PixelMark");
    expect(source).toContain("<BrandAgentIcon");
  });

  it("projects the accepted user message before the run starts", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("const receipt = await api.sendMessage");
    expect(source).toContain("event_id: receipt.event_id");
    expect(source).toContain("mergeConversationEvents");
  });

  it("offers per-Session management from each Session row", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("function SessionRow");
    expect(source).toContain("aria-label={`管理 ${title}`}");
    expect(source).toContain("onUpdateSession");
    expect(source).toContain("重命名");
    expect(source).toContain("归档");
    expect(source).toContain("删除");
  });
});
