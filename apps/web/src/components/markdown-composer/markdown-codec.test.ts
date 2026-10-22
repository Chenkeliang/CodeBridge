import { describe, expect, it } from "vitest";
import { createMarkdownCodec } from "./markdown-codec";

const codec = createMarkdownCodec();

describe("Markdown Composer codec", () => {
  it("round-trips rich Markdown semantically", () => {
    const source = [
      "# 标题",
      "",
      "**粗体**、*斜体*、`inline` 和 [链接](https://example.com)",
      "",
      "- [x] 已完成",
      "- [ ] 待处理",
      "",
      "> 引用",
    ].join("\n");

    const document = codec.parse(source);
    const markdown = codec.serialize(document);

    expect(document.content?.map((node) => node.type)).toEqual([
      "heading",
      "paragraph",
      "taskList",
      "blockquote",
    ]);
    expect(markdown).toContain("# 标题");
    expect(markdown).toContain("**粗体**");
    expect(markdown).toContain("- [x] 已完成");
    expect(markdown).toContain("> 引用");
  });

  it.each([
    ["code", "```ts\nconst value = 1;\n```"],
    ["mermaid", "```mermaid\ngraph TD\n  A --> B\n```"],
    ["table", "| 名称 | 状态 |\n| --- | --- |\n| Composer | 完成 |"],
    ["math", "$$\nE = mc^2\n$$"],
  ] as const)("keeps %s syntax in an editable source block", (kind, source) => {
    const document = codec.parse(source);
    const block = document.content?.[0];

    expect(block).toMatchObject({
      type: "sourceBlock",
      attrs: { kind },
      content: [{ type: "text", text: source }],
    });
    expect(codec.serialize(document)).toBe(source);
  });

  it("preserves the original source if parsing throws", () => {
    const broken = "# 原文\n\n必须保留";
    const fallback = codec.parseSafely(broken, () => {
      throw new Error("parse failed");
    });

    expect(fallback.failed).toBe(true);
    expect(fallback.document.content?.[0]).toMatchObject({
      type: "sourceBlock",
      attrs: { kind: "markdown" },
      content: [{ type: "text", text: broken }],
    });
  });
});
