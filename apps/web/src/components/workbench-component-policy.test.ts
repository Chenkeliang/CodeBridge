import { readFileSync } from "node:fs";
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
    expect(source).not.toContain("Agent · working");
  });
});
