import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Workbench component policy", () => {
  it("uses the shadcn Select primitive instead of native select controls", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain('from "@/components/ui/select"');
    expect(source).not.toMatch(/<select\b/);
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

  it("keeps Agent-native model and permission controls in the Composer", () => {
    const source = readFileSync(new URL("./workbench.tsx", import.meta.url), "utf8");

    expect(source).toContain("permissionOption={permissionOption}");
    expect(source).toContain("onPermissionMode={setSessionPermissionMode}");
    expect(source).toContain('label="Agent default"');
    expect(source).toContain("<SelectValue>{triggerLabel}</SelectValue>");
    expect(source).toContain('session.status === "active" || session.status === "idle" ? t.healthyDot : t.offlineDot');
  });
});
