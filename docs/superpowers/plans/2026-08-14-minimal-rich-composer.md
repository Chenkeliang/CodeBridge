# Minimal Rich Composer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the plain textarea with a minimal rich Markdown Composer, preserve every existing attachment/configuration/queue/Run behavior, add local frosted interaction surfaces in both themes, and reveal only newly streamed Assistant content.

**Architecture:** `Workbench` remains the authority for the canonical Markdown draft, attachments, Session configuration, submission, queue, and Run cancellation. A focused Tiptap editor parses Markdown into an editable document and serializes every valid update back to canonical Markdown; unsupported block syntax is protected as editable source blocks so it cannot be lost. The existing `Composer` becomes a thin layout/orchestration component, while explicit primitive variants and live-segment metadata keep visual effects local and prevent historical Timeline replay.

**Tech Stack:** React 19, TypeScript, Tiptap 3/ProseMirror, Radix/shadcn primitives, Tailwind CSS 4 semantic tokens, Vitest/jsdom.

---

## File map

| File | Responsibility |
|---|---|
| `apps/web/src/components/markdown-composer/markdown-codec.ts` | Protect unsupported Markdown blocks, parse Markdown to Tiptap JSON, serialize Tiptap JSON to canonical Markdown, and preserve original text on parse failure. |
| `apps/web/src/components/markdown-composer/source-block.ts` | Define the editable Tiptap node used for fenced code, Mermaid, tables, and block math source. |
| `apps/web/src/components/markdown-composer/markdown-composer.tsx` | Own the Tiptap instance, external draft synchronization, Markdown paste, IME-safe keyboard behavior, and serialization failure state. |
| `apps/web/src/components/markdown-composer/markdown-composer.test.tsx` | Exercise rich parsing, unsupported-source preservation, Markdown paste, external reset, IME, Enter, and Shift+Enter. |
| `apps/web/src/components/composer-attachments.tsx` | Render image/file previews above the editor and remove an attachment without changing its request shape. |
| `apps/web/src/components/composer-controls.tsx` | Render the `+` menu, permission control, grouped model/reasoning/speed controls, Flow, and Workspace actions. |
| `apps/web/src/components/composer.tsx` | Compose the minimal shell, floating command/context pickers, attachments, rich editor, Stop, and Send. |
| `apps/web/src/components/composer.test.tsx` | Verify minimal geometry and preservation of files, Workspace, Flow, permission, model, reasoning, speed, Stop, Send, `/`, `@`, and attachments. |
| `apps/web/src/components/workbench.tsx` | Keep existing state authority and callbacks; surface editor serialization errors without changing submission APIs. |
| `apps/web/src/components/session-timeline.tsx` | Mark only newly added unsealed Assistant segments for reveal and show a caret on the active segment. |
| `apps/web/src/components/session-timeline.test.tsx` | Prove initial hydration/pagination do not reveal, new live segments reveal once, and the caret tracks only unsealed content. |
| `apps/web/src/components/ui/popover.tsx` | Add an opt-in `frosted` surface variant. |
| `apps/web/src/components/ui/select.tsx` | Add the same opt-in `frosted` surface variant. |
| `apps/web/src/components/command-palette.tsx` | Opt the existing floating Command Palette into the frosted interaction surface without changing its commands. |
| `apps/web/src/index.css` | Define dual-theme overlay tokens, editor/source-block typography, local frosted utility, live reveal/caret motion, and reduced-motion overrides. |
| `apps/web/src/design-tokens.test.ts` | Verify both themes expose the same overlay tokens and frosted surfaces use semantic variables. |
| `apps/web/src/components/workbench-component-policy.test.ts` | Replace old textarea/top-toolbar policy assertions with the approved minimal Composer and local-glass rules. |
| `apps/web/package.json` | Declare the Tiptap packages used directly by the Web application. |
| `pnpm-lock.yaml` | Lock the new frontend dependencies. |
| `docs/orchestration/DESIGN.md` | Document the minimal Composer, rich/source Markdown boundary, local glass scope, dual-theme tokens, and motion rules. |

No file under `apps/bridge`, `apps/coordinator`, `packages/session-store`, or any backend/runtime package is in scope.

### Task 1: Markdown codec and editable source blocks

**Files:**
- Modify: `apps/web/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/web/src/components/markdown-composer/source-block.ts`
- Create: `apps/web/src/components/markdown-composer/markdown-codec.ts`
- Create: `apps/web/src/components/markdown-composer/markdown-codec.test.ts`

- [ ] **Step 1: Add the editor dependencies**

Run:

```bash
pnpm --filter @codebridge/web add @tiptap/core@^3.30.1 @tiptap/extension-placeholder@^3.30.1 @tiptap/extension-task-item@^3.30.1 @tiptap/extension-task-list@^3.30.1 @tiptap/markdown@^3.30.1 @tiptap/pm@^3.30.1 @tiptap/react@^3.30.1 @tiptap/starter-kit@^3.30.1
```

Expected: `apps/web/package.json` contains the eight direct dependencies and `pnpm-lock.yaml` resolves one compatible Tiptap 3.30.x graph.

- [ ] **Step 2: Write failing codec tests**

Create `apps/web/src/components/markdown-composer/markdown-codec.test.ts`:

```ts
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
  ])("keeps %s syntax in an editable source block", (kind, source) => {
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
```

- [ ] **Step 3: Run the codec test and verify it fails**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/markdown-composer/markdown-codec.test.ts
```

Expected: FAIL because `markdown-codec.ts` does not exist.

- [ ] **Step 4: Define the editable source node**

Create `apps/web/src/components/markdown-composer/source-block.ts`:

```ts
import { Node, mergeAttributes } from "@tiptap/core";

export type SourceBlockKind = "code" | "mermaid" | "table" | "math" | "markdown";

export const SourceBlock = Node.create({
  name: "sourceBlock",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,

  addAttributes() {
    return {
      kind: {
        default: "markdown",
        parseHTML: (element) => element.getAttribute("data-source-kind") ?? "markdown",
      },
    };
  },

  parseHTML() {
    return [{ tag: "pre[data-markdown-source]" }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "pre",
      mergeAttributes(HTMLAttributes, {
        "data-markdown-source": "",
        "data-source-kind": HTMLAttributes.kind,
      }),
      ["code", 0],
    ];
  },
});
```

- [ ] **Step 5: Implement protected parsing and serialization**

Create `apps/web/src/components/markdown-composer/markdown-codec.ts` with these public contracts:

```ts
import type { JSONContent } from "@tiptap/core";
import { Editor } from "@tiptap/core";
import { Markdown } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { SourceBlock, type SourceBlockKind } from "./source-block";

const sentinelLanguage = "codebridge-source";
type ParseResult = {
  document: JSONContent;
  failed: boolean;
};

function encodeSource(kind: SourceBlockKind, source: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify({ kind, source }));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function decodeSource(value: string): { kind: SourceBlockKind; source: string } {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as {
    kind: SourceBlockKind;
    source: string;
  };
}

function sourceDocument(source: string, kind: SourceBlockKind = "markdown"): JSONContent {
  return {
    type: "doc",
    content: [{
      type: "sourceBlock",
      attrs: { kind },
      content: source ? [{ type: "text", text: source }] : [],
    }],
  };
}

function sourceKind(source: string): SourceBlockKind {
  if (source.startsWith("```mermaid")) return "mermaid";
  if (source.startsWith("```")) return "code";
  if (source.startsWith("$$")) return "math";
  return "table";
}

function protectUnsupportedBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (line.startsWith("```")) {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        block.push(lines[index] ?? "");
        const closing = lines[index]?.startsWith("```");
        index += 1;
        if (closing) break;
      }
      const source = block.join("\n");
      output.push(`\`\`\`${sentinelLanguage}\n${encodeSource(sourceKind(source), source)}\n\`\`\``);
      continue;
    }
    if (line.trim() === "$$") {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        block.push(lines[index] ?? "");
        const closing = lines[index]?.trim() === "$$";
        index += 1;
        if (closing) break;
      }
      const source = block.join("\n");
      output.push(`\`\`\`${sentinelLanguage}\n${encodeSource("math", source)}\n\`\`\``);
      continue;
    }
    const alignment = lines[index + 1] ?? "";
    if (line.includes("|") && /^\s*\|?\s*:?-{3,}:?(\s*\|\s*:?-{3,}:?)+\s*\|?\s*$/.test(alignment)) {
      const block = [line, alignment];
      index += 2;
      while (index < lines.length && (lines[index] ?? "").includes("|") && (lines[index] ?? "").trim()) {
        block.push(lines[index] ?? "");
        index += 1;
      }
      const source = block.join("\n");
      output.push(`\`\`\`${sentinelLanguage}\n${encodeSource("table", source)}\n\`\`\``);
      continue;
    }
    output.push(line);
    index += 1;
  }
  return output.join("\n");
}

function mapDocument(node: JSONContent, mapper: (node: JSONContent) => JSONContent): JSONContent {
  const mapped = {
    ...node,
    content: node.content?.map((child) => mapDocument(child, mapper)),
  };
  return mapper(mapped);
}

export function createMarkdownCodec() {
  const editor = new Editor({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      SourceBlock,
      Markdown,
    ],
    content: "",
  });

  function parseWith(markdown: string): JSONContent {
    const parsed = editor.markdown.parse(protectUnsupportedBlocks(markdown));
    return mapDocument(parsed, (node) => {
      if (node.type !== "codeBlock" || node.attrs?.language !== sentinelLanguage) return node;
      const encoded = node.content?.map((child) => child.text ?? "").join("") ?? "";
      const decoded = decodeSource(encoded);
      return {
        type: "sourceBlock",
        attrs: { kind: decoded.kind },
        content: decoded.source ? [{ type: "text", text: decoded.source }] : [],
      };
    });
  }

  function serialize(document: JSONContent): string {
    const protectedDocument = mapDocument(document, (node) => {
      if (node.type !== "sourceBlock") return node;
      const source = node.content?.map((child) => child.text ?? "").join("") ?? "";
      const encoded = encodeSource(node.attrs?.kind as SourceBlockKind, source);
      return {
        type: "codeBlock",
        attrs: { language: sentinelLanguage },
        content: [{ type: "text", text: encoded }],
      };
    });
    return editor.markdown.serialize(protectedDocument).replace(
      /```codebridge-source\n([A-Za-z0-9+/=]+)\n```/g,
      (_, encoded: string) => decodeSource(encoded).source,
    ).trimEnd();
  }

  return {
    parse: parseWith,
    parseSafely(markdown: string, parse = parseWith): ParseResult {
      try {
        return { document: parse(markdown), failed: false };
      } catch {
        return { document: sourceDocument(markdown), failed: true };
      }
    },
    serialize,
  };
}
```

- [ ] **Step 6: Run codec tests and type-check**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/markdown-composer/markdown-codec.test.ts && pnpm --filter @codebridge/web typecheck
```

Expected: PASS; no unsafe casts or missing Tiptap Markdown types.

- [ ] **Step 7: Commit the codec**

```bash
git add apps/web/package.json pnpm-lock.yaml apps/web/src/components/markdown-composer/source-block.ts apps/web/src/components/markdown-composer/markdown-codec.ts apps/web/src/components/markdown-composer/markdown-codec.test.ts
git commit -m "feat(web): add rich markdown composer codec"
```

### Task 2: Rich editor behavior

**Files:**
- Create: `apps/web/src/components/markdown-composer/markdown-composer.tsx`
- Create: `apps/web/src/components/markdown-composer/markdown-composer.test.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: Write failing editor behavior tests**

Create `apps/web/src/components/markdown-composer/markdown-composer.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MarkdownComposer } from "./markdown-composer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderEditor(overrides: Partial<ComponentProps<typeof MarkdownComposer>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props = {
    disabled: false,
    value: "",
    onChange: vi.fn(),
    onFiles: vi.fn(async () => undefined),
    onSubmit: vi.fn(),
    onTrigger: vi.fn(),
    onPickerKey: vi.fn(() => false),
    onSerializationError: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<MarkdownComposer {...props} />));
  return { host, props, root };
}

describe("MarkdownComposer", () => {
  it("renders supported Markdown as rich editable content", () => {
    const view = renderEditor({ value: "# 标题\n\n- [x] 完成" });
    expect(view.host.querySelector("[contenteditable=true] h1")?.textContent).toBe("标题");
    expect(view.host.querySelector('input[type="checkbox"]')).not.toBeNull();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("keeps unsupported syntax as an editable source block", () => {
    const source = "| A | B |\n| --- | --- |\n| 1 | 2 |";
    const view = renderEditor({ value: source });
    expect(view.host.querySelector("[data-markdown-source]")?.textContent).toBe(source);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("parses Markdown pasted as plain text and forwards pasted files", () => {
    const view = renderEditor();
    const editor = view.host.querySelector("[contenteditable=true]")!;
    const file = new File(["image"], "paste.png", { type: "image/png" });
    const clipboardData = {
      files: [file],
      getData: (type: string) => type === "text/plain" ? "**粘贴**" : "",
    };
    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", { value: clipboardData });
    act(() => editor.dispatchEvent(paste));
    expect(view.props.onFiles).toHaveBeenCalledWith([file]);
    expect(view.host.querySelector("strong")?.textContent).toBe("粘贴");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("submits on Enter, inserts a line break on Shift+Enter, and ignores composing Enter", () => {
    const view = renderEditor({ value: "消息" });
    const editor = view.host.querySelector("[contenteditable=true]")!;

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
    expect(view.props.onSubmit).toHaveBeenCalledTimes(1);

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", shiftKey: true })));
    expect(view.props.onSubmit).toHaveBeenCalledTimes(1);

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true })));
    expect(view.props.onSubmit).toHaveBeenCalledTimes(1);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("accepts an external clear without resetting locally emitted updates", () => {
    const onChange = vi.fn();
    const view = renderEditor({ value: "待发送", onChange });
    act(() => view.root.render(<MarkdownComposer {...view.props} value="" onChange={onChange} />));
    expect(view.host.querySelector("[contenteditable=true]")?.textContent).toBe("");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("retains StarterKit undo and redo history", () => {
    const view = renderEditor();
    const editor = view.host.querySelector("[contenteditable=true]")!;
    const paste = (text: string) => {
      const event = new Event("paste", { bubbles: true });
      Object.defineProperty(event, "clipboardData", {
        value: { files: [], getData: () => text },
      });
      act(() => editor.dispatchEvent(event));
    };
    paste("第一段");
    paste("第二段");
    expect(editor.textContent).toContain("第一段第二段");
    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "z" })));
    expect(editor.textContent).toBe("第一段");
    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ctrlKey: true, key: "z", shiftKey: true })));
    expect(editor.textContent).toContain("第一段第二段");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("reports slash and Workspace triggers from the active trailing token", () => {
    const onTrigger = vi.fn();
    const view = renderEditor({ onTrigger });
    const editor = view.host.querySelector("[contenteditable=true]")!;
    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { files: [], getData: () => "/sta" },
    });
    act(() => editor.dispatchEvent(paste));
    expect(onTrigger).toHaveBeenLastCalledWith({ kind: "command", query: "sta" });
    act(() => view.root.render(<MarkdownComposer {...view.props} value="@src" onTrigger={onTrigger} />));
    expect(onTrigger).toHaveBeenLastCalledWith({ kind: "context", query: "src" });
    act(() => view.root.unmount());
    view.host.remove();
  });
});
```

- [ ] **Step 2: Run the editor test and verify it fails**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/markdown-composer/markdown-composer.test.tsx
```

Expected: FAIL because `markdown-composer.tsx` does not exist.

- [ ] **Step 3: Implement the Tiptap editor**

Create `apps/web/src/components/markdown-composer/markdown-composer.tsx` with this interface and behavior:

```tsx
import { useEffect, useMemo, useRef } from "react";
import { Extension } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { Plugin } from "@tiptap/pm/state";
import { Markdown } from "@tiptap/markdown";
import { createMarkdownCodec } from "./markdown-codec";
import { SourceBlock } from "./source-block";

export type ComposerTrigger = {
  kind: "command" | "context";
  query: string;
} | null;

export function MarkdownComposer(props: {
  disabled: boolean;
  value: string;
  onChange: (markdown: string) => void;
  onFiles: (files: File[]) => Promise<void>;
  onSubmit: () => void;
  onTrigger: (trigger: ComposerTrigger) => void;
  onPickerKey: (event: {
    key: "Escape" | "ArrowUp" | "ArrowDown" | "Enter" | "Tab";
    shiftKey: boolean;
  }) => boolean;
  onSerializationError: (message: string | null) => void;
}) {
  const codec = useMemo(() => createMarkdownCodec(), []);
  const lastEmitted = useRef(props.value);
  const callbacks = useRef(props);
  callbacks.current = props;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !props.disabled,
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      SourceBlock,
      Markdown,
      Placeholder.configure({ placeholder: "输入目标，或继续当前工作…" }),
      Extension.create({
        name: "composerEvents",
        addKeyboardShortcuts() {
          return {
            Escape: () => callbacks.current.onPickerKey({ key: "Escape", shiftKey: false }),
            ArrowUp: () => callbacks.current.onPickerKey({ key: "ArrowUp", shiftKey: false }),
            ArrowDown: () => callbacks.current.onPickerKey({ key: "ArrowDown", shiftKey: false }),
            Tab: () => callbacks.current.onPickerKey({ key: "Tab", shiftKey: false }),
            Enter: () => {
              if (this.editor.view.composing) return false;
              if (callbacks.current.onPickerKey({ key: "Enter", shiftKey: false })) return true;
              callbacks.current.onSubmit();
              return true;
            },
            "Shift-Enter": () => this.editor.commands.setHardBreak(),
          };
        },
        addProseMirrorPlugins() {
          return [new Plugin({
            props: {
              handlePaste: (_view, event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length) void callbacks.current.onFiles(files);
                const text = event.clipboardData?.getData("text/plain") ?? "";
                if (!text) return files.length > 0;
                const parsed = codec.parseSafely(text);
                this.editor.commands.insertContent(parsed.document.content ?? []);
                return true;
              },
            },
          })];
        },
      }),
    ],
    content: codec.parseSafely(props.value).document,
    onUpdate: ({ editor: current }) => {
      try {
        const markdown = codec.serialize(current.getJSON());
        lastEmitted.current = markdown;
        callbacks.current.onSerializationError(null);
        callbacks.current.onChange(markdown);
        callbacks.current.onTrigger(triggerAtEnd(markdown));
      } catch (error) {
        callbacks.current.onSerializationError(error instanceof Error ? error.message : "Markdown 序列化失败");
      }
    },
  });

  useEffect(() => {
    editor?.setEditable(!props.disabled);
  }, [editor, props.disabled]);

  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    const parsed = codec.parseSafely(props.value);
    editor.commands.setContent(parsed.document, { emitUpdate: false });
    lastEmitted.current = props.value;
    props.onTrigger(triggerAtEnd(props.value));
    props.onSerializationError(parsed.failed ? "Markdown 解析失败，已保留原文" : null);
  }, [codec, editor, props.value, props.onSerializationError, props.onTrigger]);

  return <EditorContent
    aria-label="消息"
    className="markdown-composer"
    editor={editor}
  />;
}

function triggerAtEnd(markdown: string): ComposerTrigger {
  const match = markdown.match(/(?:^|\s)([/@])([^\s]*)$/);
  if (!match) return null;
  return {
    kind: match[1] === "/" ? "command" : "context",
    query: match[2] ?? "",
  };
}
```

Keep the existing popup keyboard contract for `Escape`, `ArrowUp`, `ArrowDown`, and `Tab/Enter` selection. Return `true` only when a visible popup consumes the key. The callback interface is:

```ts
onPickerKey: (event: {
  key: "Escape" | "ArrowUp" | "ArrowDown" | "Enter" | "Tab";
  shiftKey: boolean;
}) => boolean;
```

- [ ] **Step 4: Add scoped editor styles**

Append to `apps/web/src/index.css`:

```css
.markdown-composer .tiptap {
  min-height: 76px;
  padding: 12px 14px;
  color: var(--agnet-ink);
  font-size: 0.875rem;
  line-height: 1.5rem;
  outline: none;
}

.markdown-composer .tiptap > * + * {
  margin-top: 0.5rem;
}

.markdown-composer .tiptap h1 {
  font-size: 1.25rem;
  line-height: 1.75rem;
}

.markdown-composer .tiptap h2 {
  font-size: 1.125rem;
  line-height: 1.625rem;
}

.markdown-composer .tiptap ul,
.markdown-composer .tiptap ol {
  padding-left: 1.25rem;
}

.markdown-composer .tiptap blockquote {
  border-left: 2px solid var(--agnet-line-strong);
  padding-left: 0.75rem;
  color: var(--agnet-ink-soft);
}

.markdown-composer .tiptap code {
  border-radius: 0.25rem;
  background: var(--agnet-surface-soft);
  padding: 0.1rem 0.3rem;
  font-family: var(--font-mono);
  font-size: 0.8125rem;
}

.markdown-composer [data-markdown-source] {
  overflow-x: auto;
  border: 1px solid var(--agnet-line);
  border-radius: 0.5rem;
  background: var(--agnet-surface-tint);
  padding: 0.75rem;
  white-space: pre-wrap;
}

.markdown-composer .is-editor-empty:first-child::before {
  float: left;
  height: 0;
  color: var(--agnet-faint);
  content: attr(data-placeholder);
  pointer-events: none;
}
```

- [ ] **Step 5: Run editor tests and the focused build**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/markdown-composer/markdown-composer.test.tsx src/components/markdown-composer/markdown-codec.test.ts && pnpm --filter @codebridge/web build
```

Expected: PASS; Tiptap compiles under React 19 and the production bundle builds.

- [ ] **Step 6: Commit editor behavior**

```bash
git add apps/web/src/components/markdown-composer/markdown-composer.tsx apps/web/src/components/markdown-composer/markdown-composer.test.tsx apps/web/src/index.css
git commit -m "feat(web): add rich markdown editor"
```

### Task 3: Minimal Composer layout with preserved attachments

**Files:**
- Create: `apps/web/src/components/composer-attachments.tsx`
- Create: `apps/web/src/components/composer-controls.tsx`
- Create: `apps/web/src/components/composer.test.tsx`
- Modify: `apps/web/src/components/composer.tsx`
- Modify: `apps/web/src/components/workbench.tsx`

- [ ] **Step 1: Write failing layout and capability tests**

Create `apps/web/src/components/composer.test.tsx`. Render `Composer` with one image, one file, all four configuration options, one Flow, a Session Workspace, and `running={true}`. Assert:

```tsx
expect(host.querySelector('[data-composer-attachments]')?.nextElementSibling)
  ?.hasAttribute("data-composer-editor")).toBe(true);
expect(host.querySelector('img[alt="paste.png"]')).not.toBeNull();
expect(host.textContent).toContain("notes.txt");
expect(host.querySelector('button[aria-label="Composer actions"]')).not.toBeNull();
expect(host.querySelector('button[aria-label="Permission"]')).not.toBeNull();
expect(host.querySelector('button[aria-label="Model and reasoning"]')).not.toBeNull();
expect(host.querySelector('button[aria-label="停止当前 Run"]')).not.toBeNull();
expect(host.querySelector('button[aria-label="发送"]')).not.toBeNull();
expect(host.textContent).not.toContain("Enter 发送");
expect(host.querySelector('[aria-label="Markdown toolbar"]')).toBeNull();
expect(host.querySelector('[aria-label="Preview"]')).toBeNull();
```

Open `Composer actions` and assert the menu contains `添加文件`, `Workspace`, and `Flow`. Open `Model and reasoning` and assert it contains the Agent-provided model, reasoning, and speed labels. Click removal, Stop, Send, files, Workspace, and Flow controls and assert their existing callbacks receive unchanged values.

- [ ] **Step 2: Run the Composer test and verify it fails**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/composer.test.tsx
```

Expected: FAIL because the old top toolbar remains and the new menu labels/geometry do not exist.

- [ ] **Step 3: Extract attachment previews**

Create `apps/web/src/components/composer-attachments.tsx`:

```tsx
import { Paperclip, X } from "lucide-react";
import type { MessageAttachmentInput } from "@/lib/types";
import { attachmentPreviewUrl } from "@/lib/workbench-logic";
import { cn } from "@/lib/utils";

export function ComposerAttachments(props: {
  attachments: MessageAttachmentInput[];
  onRemove: (index: number) => void;
}) {
  if (!props.attachments.length) return null;
  return <div className="flex flex-wrap gap-2 px-3 pt-3" data-composer-attachments>
    {props.attachments.map((attachment, index) => {
      const preview = attachmentPreviewUrl(attachment);
      return <div
        className={cn(
          "group relative overflow-hidden rounded-md border motion-safe:animate-chip-pop",
          preview ? "size-16" : "inline-flex items-center gap-1.5 px-2 py-1 text-xs",
          "border-line bg-surface-tint text-ink-soft",
        )}
        key={`${attachment.name}-${index}`}
        style={{ animationDelay: `${index * 50}ms` }}
      >
        {preview
          ? <img alt={attachment.name} className="size-full object-cover" src={preview} />
          : <><Paperclip className="size-3" /><span className="max-w-40 truncate">{attachment.name}</span></>}
        <button
          aria-label={`移除 ${attachment.name}`}
          className={cn(preview && "absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-surface")}
          onClick={() => props.onRemove(index)}
          type="button"
        >
          <X className="size-3" />
        </button>
      </div>;
    })}
  </div>;
}
```

- [ ] **Step 4: Extract the two control groups**

Create `apps/web/src/components/composer-controls.tsx` and move, without changing value resolution or callbacks:

1. `SessionConfigSelect`
2. `ReasoningLevelControl`
3. `SpeedControl`

Export:

```tsx
export function ComposerActions(props: {
  flows: FlowRecord[];
  flowId: string;
  hasWorkspace: boolean;
  onFiles: () => void;
  onFlow: (value: string) => void;
  onWorkspace: () => void;
}) {
  return <Popover>
    <PopoverTrigger asChild>
      <Button aria-label="Composer actions" size="icon" variant="ghost"><Plus className="size-4" /></Button>
    </PopoverTrigger>
    <PopoverContent align="start" className="w-64 border-line-strong text-ink-soft" side="top">
      <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-surface-soft" onClick={props.onFiles} type="button">
        <Paperclip className="size-3.5" />添加文件
      </button>
      <button className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-xs hover:bg-surface-soft" disabled={!props.hasWorkspace} onClick={props.onWorkspace} type="button">
        <FolderOpen className="size-3.5" />Workspace
      </button>
      {props.flows.length > 0 && <Select onValueChange={(value) => props.onFlow(value === DEFAULT_SELECT_VALUE ? "" : value)} value={props.flowId || DEFAULT_SELECT_VALUE}>
        <SelectTrigger aria-label="Flow" className="w-full border-0 bg-transparent px-2 shadow-none"><Workflow className="size-3.5" /><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={DEFAULT_SELECT_VALUE}>Flow · 自动</SelectItem>
          {props.flows.map((flow) => <SelectItem key={flow.flow_id} value={flow.flow_id}>{flow.name || flow.flow_id}</SelectItem>)}
        </SelectContent>
      </Select>}
    </PopoverContent>
  </Popover>;
}

export function PermissionControl(props: {
  option?: ConfigOption;
  value: string;
  onValue: (value: string) => void;
}) {
  return props.option
    ? <SessionConfigSelect label="Agent 默认" onValue={props.onValue} option={props.option} value={props.value} />
    : null;
}

export function ModelControls(props: {
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
  return <Popover>
    <PopoverTrigger asChild>
      <Button aria-label="Model and reasoning" className="max-w-52 gap-1.5" variant="ghost">
        <span className="truncate">{props.modelOption ? defaultModelLabel(props.modelOption) : "Agent 默认"}</span>
        <ChevronDown className="size-3" />
      </Button>
    </PopoverTrigger>
    <PopoverContent align="end" className="grid w-80 gap-3 border-line-strong text-ink-soft" side="top">
      {props.modelOption && <SessionConfigSelect label={defaultModelLabel(props.modelOption)} onValue={props.onModel} option={props.modelOption} value={props.model} />}
      {props.thoughtLevelOption && <ReasoningLevelControl onValue={props.onEffort} option={props.thoughtLevelOption} value={props.effort} />}
      {props.speedOption && <SpeedControl
        onValue={(value) => props.onConfigOverride(props.speedOption!, value)}
        option={props.speedOption}
        overridden={Object.hasOwn(props.configOverrides, props.speedOption.id)}
        value={String(props.configOverrides[props.speedOption.id] ?? props.speedOption.currentValue ?? "false")}
      />}
    </PopoverContent>
  </Popover>;
}
```

Use `PopoverContent surface="frosted"` and `SelectContent surface="frosted"` after Task 4 adds those props. Until Task 4 lands, retain semantic `bg-surface` classes so this commit remains buildable.

- [ ] **Step 5: Rebuild `Composer` around the approved geometry**

In `apps/web/src/components/composer.tsx`:

1. Keep the current `Composer` props and all picker filtering/index logic.
2. Delete the top configuration strip and plain `Textarea`.
3. Render in this exact order:

```tsx
<div className="relative rounded-xl border border-line-strong bg-surface shadow-panel" data-composer>
  <ComposerAttachments attachments={attachments} onRemove={onRemoveAttachment} />
  <div data-composer-editor>
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
  </div>
  <div className="flex items-end justify-between gap-3 px-3 pb-2.5">
    <div className="flex items-center gap-1">
      <ComposerActions />
      <PermissionControl />
    </div>
    <div className="flex items-center gap-1.5">
      <ModelControls />
      {running && <StopButton />}
      <SendButton />
    </div>
  </div>
  {serializationError && <p className="px-3 pb-2 text-xs text-danger" role="alert">{serializationError}</p>}
  {commandPicker}
  {contextPicker}
  {sweep}
</div>
```

4. Disable Send when `serializationError !== null`.
5. Have `submitWithSweep` return without calling `onSubmit` when serialization has failed.
6. Preserve `running` as the only authority for Stop visibility.
7. Preserve Send usability during a Run; do not include `running` in its disabled expression.
8. Preserve `/` and `@` typing triggers; do not restore dedicated toolbar buttons.

- [ ] **Step 6: Keep Workbench authority unchanged**

In `apps/web/src/components/workbench.tsx`, leave `submit()`, `stopRun()`, `submitSessionMessage()`, attachments, and all Session callback payloads unchanged. Only remove imports made obsolete by the Composer split. The canonical draft remains:

```ts
const [draft, setDraft] = useState("");
```

and successful submission still performs:

```ts
const pendingAttachments = attachments;
setDraft("");
setAttachments([]);
```

Change only the frontend attachment reader from fail-fast `Promise.all` to settled results so successful clipboard/file reads are retained when a sibling file fails:

```ts
async function addFiles(files: FileList | File[]) {
  const results = await Promise.allSettled(Array.from(files).map(readAttachment));
  const successful = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  if (successful.length) setAttachments((current) => [...current, ...successful]);
  const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failed) setError(messageOf(failed.reason));
}
```

Add a Workbench/component test that passes one readable file and one file whose `FileReader` emits `error`; assert the readable attachment remains visible, the draft is unchanged, and the error is surfaced.

- [ ] **Step 7: Run focused Composer and Workbench tests**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/composer.test.tsx src/components/workbench-component-policy.test.ts src/lib/workbench-logic.test.ts && pnpm --filter @codebridge/web build
```

Expected: component test PASS; policy test may still fail only on assertions intentionally replaced in Task 6; build PASS.

- [ ] **Step 8: Commit the minimal layout**

```bash
git add apps/web/src/components/composer.tsx apps/web/src/components/composer-controls.tsx apps/web/src/components/composer-attachments.tsx apps/web/src/components/composer.test.tsx apps/web/src/components/workbench.tsx
git commit -m "feat(web): simplify composer controls"
```

### Task 4: Explicit frosted interaction surfaces in both themes

**Files:**
- Modify: `apps/web/src/components/ui/popover.tsx`
- Modify: `apps/web/src/components/ui/select.tsx`
- Modify: `apps/web/src/components/composer.tsx`
- Modify: `apps/web/src/components/composer-controls.tsx`
- Modify: `apps/web/src/components/command-palette.tsx`
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/design-tokens.test.ts`

- [ ] **Step 1: Write failing token and primitive tests**

Add to `apps/web/src/design-tokens.test.ts`:

```ts
it("defines matching semantic overlay tokens and scopes frosting to opt-in surfaces", () => {
  expect(paper["--agnet-overlay"]).toBe("#FFFFFF");
  expect(carbon["--agnet-overlay"]).toBe("#1D1D1D");
  expect(Object.keys(paper).sort()).toEqual(Object.keys(carbon).sort());
  expect(css).toContain(".surface-frosted");
  expect(css).toContain("background: color-mix(in srgb, var(--agnet-overlay)");
  expect(css).toContain("backdrop-filter: blur(");
});
```

Add source assertions to `workbench-component-policy.test.ts`:

```ts
expect(popover).toContain('surface?: "solid" | "frosted"');
expect(select).toContain('surface?: "solid" | "frosted"');
expect(composer).toContain('surface="frosted"');
expect(workbench).not.toContain("backdrop-blur");
```

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
pnpm --filter @codebridge/web test -- src/design-tokens.test.ts src/components/workbench-component-policy.test.ts
```

Expected: FAIL because `--agnet-overlay`, `.surface-frosted`, and primitive surface props do not exist.

- [ ] **Step 3: Add matching semantic tokens and a local utility**

Add to the Paper token block in `apps/web/src/index.css`:

```css
--agnet-overlay: #FFFFFF;
--agnet-overlay-strength: 94%;
```

and to Carbon:

```css
--agnet-overlay: #1D1D1D;
--agnet-overlay-strength: 84%;
```

for Carbon. Add:

```css
@utility surface-frosted {
  background: color-mix(in srgb, var(--agnet-overlay) var(--agnet-overlay-strength), transparent);
  backdrop-filter: blur(18px) saturate(1.12);
  -webkit-backdrop-filter: blur(18px) saturate(1.12);
}
```

Expose `--color-overlay: var(--agnet-overlay);` in `@theme inline`.

- [ ] **Step 4: Add opt-in primitive variants**

Change `PopoverContent` to:

```tsx
type PopoverContentProps = React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
  surface?: "solid" | "frosted";
};

const PopoverContent = React.forwardRef<
  React.ElementRef<typeof PopoverPrimitive.Content>,
  PopoverContentProps
>(({ align = "center", className, sideOffset = 6, surface = "solid", ...props }, ref) => (
  // existing Portal
  <PopoverPrimitive.Content
    className={cn(
      "z-50 rounded-lg border p-3 outline-none shadow-lg",
      surface === "frosted" ? "surface-frosted" : "bg-surface",
      className,
    )}
    // preserve existing animation classes, ref, sideOffset, and props
  />
));
```

Apply the same `surface?: "solid" | "frosted"` contract to `SelectContent`. Do not change the default from `solid`, so unrelated popovers/selects remain opaque.

- [ ] **Step 5: Opt in only Composer interaction layers**

Use `surface="frosted"` on:

1. `ComposerActions` popover.
2. `ModelControls` popover.
3. Permission/model/speed selects opened from the Composer.
4. The floating command picker.
5. The floating Workspace/context picker.
6. The Command Palette.

Add `surface-frosted` to the Composer root. Do not add it to Header, Agent Rail, Session Panel, conversation canvas, Timeline cards, settings, or ordinary cards.

- [ ] **Step 6: Run dual-theme token and component tests**

Run:

```bash
pnpm --filter @codebridge/web test -- src/design-tokens.test.ts src/components/composer.test.tsx src/components/workbench-component-policy.test.ts && pnpm --filter @codebridge/web build
```

Expected: PASS in both token tables; no global glass assertion; build PASS.

- [ ] **Step 7: Commit the surface treatment**

```bash
git add apps/web/src/components/ui/popover.tsx apps/web/src/components/ui/select.tsx apps/web/src/components/composer.tsx apps/web/src/components/composer-controls.tsx apps/web/src/components/command-palette.tsx apps/web/src/index.css apps/web/src/design-tokens.test.ts apps/web/src/components/workbench-component-policy.test.ts
git commit -m "feat(web): add scoped frosted surfaces"
```

### Task 5: Live-only Assistant reveal and streaming caret

**Files:**
- Modify: `apps/web/src/components/session-timeline.tsx`
- Modify: `apps/web/src/components/session-timeline.test.tsx`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/index.css`

- [ ] **Step 1: Write failing hydration and live-update tests**

Extend `apps/web/src/components/session-timeline.test.tsx`:

```tsx
it("does not replay reveal motion for initially hydrated Assistant segments", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const initial = [{
    timeline_index: 0,
    turn_id: "turn-1",
    run_id: "run-1",
    status: "running",
    blocks: [{
      block_id: "assistant-1",
      block_index: 0,
      kind: "assistant",
      status: "running",
      segments: [segment("already-present", "已有内容", false)],
      next_segment_cursor: null,
    }],
  }] satisfies TimelineTurnView[];

  act(() => root.render(<SessionTimeline hasEarlier={false} loadingBlockId={null} loadingEarlier={false} onLoadEarlier={vi.fn()} onLoadSegments={vi.fn()} turns={initial} />));
  const hydrated = host.querySelector('[data-segment-id="already-present"]');
  expect(hydrated?.classList.contains("assistant-reveal")).toBe(false);
  expect(hydrated?.hasAttribute("data-streaming-caret")).toBe(true);
  act(() => root.unmount());
  host.remove();
});

it("reveals only a newly appended unsealed Assistant segment", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const initial = assistantTurns([segment("stable", "第一段")]);
  act(() => root.render(<SessionTimeline {...timelineProps} turns={initial} />));
  act(() => root.render(<SessionTimeline {...timelineProps} turns={assistantTurns([
    segment("stable", "第一段"),
    segment("live", "第二段", false),
  ])} />));

  expect(host.querySelector('[data-segment-id="stable"]')?.classList.contains("assistant-reveal")).toBe(false);
  expect(host.querySelector('[data-segment-id="live"]')?.classList.contains("assistant-reveal")).toBe(true);
  expect(host.querySelectorAll("[data-streaming-caret]")).toHaveLength(1);
  act(() => root.unmount());
  host.remove();
});

it("does not reveal sealed segments introduced by earlier-page loading", () => {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  act(() => root.render(<SessionTimeline {...timelineProps} turns={assistantTurns([
    segment("recent", "最近内容"),
  ])} />));
  act(() => root.render(<SessionTimeline {...timelineProps} turns={assistantTurns([
    segment("earlier", "更早内容"),
    segment("recent", "最近内容"),
  ])} />));
  expect(host.querySelector('[data-segment-id="earlier"]')?.classList.contains("assistant-reveal")).toBe(false);
  expect(host.querySelector('[data-segment-id="recent"]')?.classList.contains("assistant-reveal")).toBe(false);
  act(() => root.unmount());
  host.remove();
});
```

Add these concrete helpers above the tests:

```tsx
const timelineProps = {
  hasEarlier: false,
  loadingBlockId: null,
  loadingEarlier: false,
  onLoadEarlier: vi.fn(),
  onLoadSegments: vi.fn(),
};

function assistantTurns(segments: TimelineSegmentView[]): TimelineTurnView[] {
  return [{
    timeline_index: 0,
    turn_id: "turn-1",
    run_id: "run-1",
    status: segments.some((value) => !value.sealed) ? "running" : "succeeded",
    blocks: [{
      block_id: "assistant-1",
      block_index: 0,
      kind: "assistant",
      status: segments.some((value) => !value.sealed) ? "running" : "succeeded",
      segments,
      next_segment_cursor: null,
    }],
  }];
}
```

- [ ] **Step 2: Run the Timeline test and verify it fails**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/session-timeline.test.tsx
```

Expected: FAIL because segments have neither IDs, reveal classification, nor caret metadata.

- [ ] **Step 3: Track segment IDs per mounted Session Timeline**

In `SessionTimeline`, initialize a ref from every segment present on the first render:

```tsx
const seenSegments = useRef(new Set(
  props.turns.flatMap((turn) =>
    turn.blocks.flatMap((block) => block.segments.map((segment) => segment.segment_id)),
  ),
));
const newlyLive = new Set<string>();
for (const turn of props.turns) {
  for (const block of turn.blocks) {
    if (block.kind !== "assistant") continue;
    for (const segment of block.segments) {
      if (!segment.sealed && !seenSegments.current.has(segment.segment_id)) {
        newlyLive.add(segment.segment_id);
      }
    }
  }
}
useEffect(() => {
  for (const turn of props.turns) {
    for (const block of turn.blocks) {
      for (const segment of block.segments) {
        seenSegments.current.add(segment.segment_id);
      }
    }
  }
}, [props.turns]);
```

Pass `reveal={newlyLive.has(segment.segment_id)}` and `streamingCaret={!segment.sealed}` only through Assistant blocks. Thought, work, tool, approval, error, and user blocks never use the Assistant reveal class or caret.

In `apps/web/src/components/workbench.tsx`, key the Timeline by Session so switching Sessions remounts the live-segment tracker with the new snapshot already marked as seen:

```tsx
<SessionTimeline
  key={selectedSessionId}
  // preserve all existing props
/>
```

- [ ] **Step 4: Mark live segments and caret**

Change `TimelineSegment` to:

```tsx
export const TimelineSegment = memo(
  function TimelineSegment({ reveal = false, segment, streamingCaret = false }: {
    reveal?: boolean;
    segment: TimelineSegmentView;
    streamingCaret?: boolean;
  }) {
    return <div
      className={cn(reveal && "assistant-reveal")}
      data-active-segment={segment.sealed ? undefined : true}
      data-segment-id={segment.segment_id}
      data-streaming-caret={streamingCaret ? true : undefined}
    >
      <Markdown content={segment.content} />
    </div>;
  },
  (previous, next) =>
    previous.reveal === next.reveal
    && previous.streamingCaret === next.streamingCaret
    && previous.segment.segment_id === next.segment.segment_id
    && previous.segment.content === next.segment.content
    && previous.segment.sealed === next.segment.sealed,
);
```

- [ ] **Step 5: Add restrained paragraph reveal and caret CSS**

Add to `apps/web/src/index.css`:

```css
.assistant-reveal > :where(p, ul, ol, blockquote, pre, table) {
  animation: assistant-reveal 240ms cubic-bezier(0.2, 0.7, 0.3, 1) both;
}

.assistant-reveal > :where(p, ul, ol, blockquote, pre, table):nth-child(2) {
  animation-delay: 45ms;
}

.assistant-reveal > :where(p, ul, ol, blockquote, pre, table):nth-child(n + 3) {
  animation-delay: 90ms;
}

[data-streaming-caret]::after {
  display: inline-block;
  width: 1px;
  height: 1em;
  margin-left: 0.2rem;
  background: var(--agnet-accent);
  content: "";
  vertical-align: -0.12em;
  animation: caret-blink 0.85s steps(1) infinite;
}

@keyframes assistant-reveal {
  from {
    opacity: 0;
    transform: translateY(7px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

- [ ] **Step 6: Disable nonessential effects for reduced motion**

Add one explicit media query:

```css
@media (prefers-reduced-motion: reduce) {
  .assistant-reveal > :where(p, ul, ol, blockquote, pre, table),
  [data-streaming-caret]::after,
  .composer-sweep.sent {
    animation: none !important;
  }
}
```

Composer breathing and attachment pop already use Tailwind's `motion-safe:` variant, so those animations are not emitted under `prefers-reduced-motion: reduce`.

- [ ] **Step 7: Run Timeline tests**

Run:

```bash
pnpm --filter @codebridge/web test -- src/components/session-timeline.test.tsx
```

Expected: PASS; initial active content has a caret but no reveal, newly appended active Assistant content reveals, and newly loaded sealed history does not reveal.

- [ ] **Step 8: Commit Assistant motion**

```bash
git add apps/web/src/components/session-timeline.tsx apps/web/src/components/session-timeline.test.tsx apps/web/src/components/workbench.tsx apps/web/src/index.css
git commit -m "feat(web): reveal live assistant segments"
```

### Task 6: Policy tests and design documentation

**Files:**
- Modify: `apps/web/src/components/workbench-component-policy.test.ts`
- Modify: `docs/orchestration/DESIGN.md`

- [ ] **Step 1: Replace obsolete Composer policy assertions**

In `workbench-component-policy.test.ts`, remove assertions that require:

1. Plain `Textarea`.
2. The top config strip.
3. Dedicated `/` and `@` buttons.
4. `Enter 发送`.
5. Opaque Composer interaction layers.

Add:

```ts
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
  expect(editor).toContain("onTrigger");
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
  expect(`${composer}\n${controls}\n${palette}`).toContain("surface-frosted");
  expect(workbench).not.toContain("surface-frosted");
  expect(workbench).not.toContain("backdrop-blur");
});
```

- [ ] **Step 2: Run the complete Web test suite**

Run:

```bash
pnpm --filter @codebridge/web test
```

Expected: all Web tests PASS. Fix only failures caused by the UI change; do not alter Session runtime expectations.

- [ ] **Step 3: Document tokens and interaction contracts**

Update `docs/orchestration/DESIGN.md` with:

1. `agnet.overlay` in both Paper and Carbon token tables.
2. Composer geometry: attachments, editor, lower-left actions/permission, lower-right model/reasoning/speed/Stop/Send.
3. Supported rich syntax: headings, lists, tasks, links, emphasis, quotes, inline code.
4. Editable source syntax: fenced code, Mermaid, tables, block math, and unsupported blocks.
5. Canonical Markdown serialization and semantic—not byte-identical—round trips.
6. Glass allowed only on Composer and floating interaction layers.
7. Paper and Carbon must use identical geometry.
8. Reveal applies only to newly appended live Assistant segments.
9. Historical hydration, pagination, and Session switching do not replay reveal.
10. Reduced motion disables reveal, caret, breathing, chip pop, and sweep.
11. Queue, Run, Stop, Send-during-Run, attachments, and Session authority are unchanged.

- [ ] **Step 4: Run token documentation tests**

Run:

```bash
pnpm --filter @codebridge/web test -- src/design-tokens.test.ts src/components/workbench-component-policy.test.ts
```

Expected: PASS; documented hex values match CSS and policy assertions describe the implemented surface.

- [ ] **Step 5: Commit policy and docs**

```bash
git add apps/web/src/components/workbench-component-policy.test.ts docs/orchestration/DESIGN.md
git commit -m "docs: define rich composer interaction rules"
```

### Task 7: Full frontend validation and dual-theme visual acceptance

**Files:**
- Modify only files already listed if validation finds a regression directly caused by this feature.

- [ ] **Step 1: Run all Web validation**

Run:

```bash
pnpm --filter @codebridge/web test && pnpm --filter @codebridge/web typecheck && pnpm --filter @codebridge/web build
```

Expected: all Web tests PASS, TypeScript emits no errors, and Vite completes a production build.

- [ ] **Step 2: Run repository lint and build**

Run:

```bash
pnpm lint && pnpm build
```

Expected: both commands exit 0. If the known unrelated `RunnerHost` cancellation assertion is encountered only in a full repository test, record it without changing Runner code; this task does not require a full repository test rerun unless a root script invokes it.

- [ ] **Step 3: Start the Web app for visual acceptance**

Run:

```bash
pnpm --filter @codebridge/web dev --host 127.0.0.1
```

Expected: Vite prints a local URL and the Workbench responds.

- [ ] **Step 4: Verify Paper and Carbon with identical scenarios**

In each theme, verify this exact matrix:

| Scenario | Expected |
|---|---|
| Empty Composer | Same height and control positions; no toolbar, preview, mode label, or Enter hint. |
| Pasted image + file | Image and filename render above the editor; removal does not alter the other attachment. |
| Rich Markdown paste | Heading, task list, link, emphasis, quote, and inline code appear richly. |
| Unsupported syntax | Code, Mermaid, table, and block math remain editable source and send unchanged semantically. |
| `+` menu | Files, Workspace, and Flow remain reachable. |
| Lower controls | Permission is left; model/reasoning/speed are grouped right. |
| Active Run | Stop is visible; Send remains enabled for a nonempty next message. |
| `/` and `@` | Typing opens the correct popup; arrows/Tab/Enter/Escape work. |
| Live Assistant output | Only new live paragraphs rise/fade; active segment shows one caret. |
| Session switch/history | Existing content appears immediately without reveal replay. |
| Reduced motion | Reveal, caret, breathing, attachment pop, and send sweep are absent. |
| Surfaces | Composer and its floating layers are frosted; rails, panels, header, canvas, and normal cards are opaque. |

- [ ] **Step 5: Inspect the final diff for frontend-only scope**

Run:

```bash
git status --short
git --no-pager diff --stat d2b8c2c..HEAD
git --no-pager diff --name-only d2b8c2c..HEAD
```

Expected: changes are limited to `apps/web`, `pnpm-lock.yaml`, `apps/web/package.json`, `docs/orchestration/DESIGN.md`, this plan, and the approved design spec commit. `.claude/`, `.playwright-cli/`, `.superpowers/`, `AGENTS.md`, `CLAUDE.md`, and `output/` remain untracked and unstaged.

- [ ] **Step 6: Confirm branch history safety before any handoff**

Run:

```bash
git fetch origin
git rev-list --count origin/main..HEAD
git --no-pager log --oneline origin/main..HEAD
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/develop)" && echo BAD || true
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/release)" && echo BAD || true
```

Expected: because `feat_web_react_architecture` was inherited far ahead of `origin/main`, do not merge or push it. Report the existing branch-history risk and create a clean production-base branch with only the intended UI commits before a PR is requested.
