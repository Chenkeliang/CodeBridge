// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { MarkdownComposer } from "./markdown-composer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function renderEditor(overrides: Partial<ComponentProps<typeof MarkdownComposer>> = {}) {
  const host = document.body.appendChild(document.createElement("div"));
  const root = createRoot(host);
  const props: ComponentProps<typeof MarkdownComposer> = {
    disabled: false,
    value: "",
    onChange: vi.fn(),
    onFiles: vi.fn(async () => undefined),
    onPickerKey: vi.fn(() => false),
    onSerializationError: vi.fn(),
    onSubmit: vi.fn(),
    onTrigger: vi.fn(),
    ...overrides,
  };
  act(() => root.render(<MarkdownComposer {...props} />));
  return { host, props, root };
}

function paste(editor: Element, text: string, files: File[] = []) {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", {
    value: {
      files,
      getData: (type: string) => type === "text/plain" ? text : "",
    },
  });
  act(() => editor.dispatchEvent(event));
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

  it("parses pasted Markdown and forwards pasted files", () => {
    const view = renderEditor();
    const editor = view.host.querySelector("[contenteditable=true]")!;
    const file = new File(["image"], "paste.png", { type: "image/png" });

    paste(editor, "**粘贴**", [file]);

    expect(view.props.onFiles).toHaveBeenCalledWith([file]);
    expect(view.host.querySelector("strong")?.textContent).toBe("粘贴");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("submits on Enter, inserts a line break on Shift+Enter, and ignores composing Enter", () => {
    const view = renderEditor({ value: "消息" });
    const editor = view.host.querySelector("[contenteditable=true]")!;

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));
    expect(view.props.onSubmit).toHaveBeenCalledTimes(1);

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter", shiftKey: true })));
    expect(view.props.onSubmit).toHaveBeenCalledTimes(1);

    const composingEnter = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" });
    Object.defineProperty(composingEnter, "isComposing", { value: true });
    act(() => editor.dispatchEvent(composingEnter));
    expect(view.props.onSubmit).toHaveBeenCalledTimes(1);
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("lets an open picker consume Enter before submission", () => {
    const onPickerKey = vi.fn(({ key }: { key: string }) => key === "Enter");
    const view = renderEditor({ onPickerKey, value: "/sta" });
    const editor = view.host.querySelector("[contenteditable=true]")!;

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" })));

    expect(onPickerKey).toHaveBeenCalledWith({ key: "Enter", shiftKey: false });
    expect(view.props.onSubmit).not.toHaveBeenCalled();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("accepts an external clear without emitting a replacement update", () => {
    const onChange = vi.fn();
    const view = renderEditor({ value: "待发送", onChange });
    onChange.mockClear();

    act(() => view.root.render(<MarkdownComposer {...view.props} onChange={onChange} value="" />));

    expect(view.host.querySelector("[contenteditable=true]")?.textContent).toBe("");
    expect(onChange).not.toHaveBeenCalled();
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("retains StarterKit undo and redo history", () => {
    const view = renderEditor();
    const editor = view.host.querySelector("[contenteditable=true]")!;

    paste(editor, "第一段");
    paste(editor, "第二段");
    expect(editor.textContent).toContain("第一段第二段");

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z" })));
    expect(editor.textContent).toBe("第一段");

    act(() => editor.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ctrlKey: true, key: "z", shiftKey: true })));
    expect(editor.textContent).toContain("第一段第二段");
    act(() => view.root.unmount());
    view.host.remove();
  });

  it("reports slash and Workspace triggers from the active trailing token", () => {
    const onTrigger = vi.fn();
    const view = renderEditor({ onTrigger });
    const editor = view.host.querySelector("[contenteditable=true]")!;

    paste(editor, "/sta");
    expect(onTrigger).toHaveBeenLastCalledWith({ kind: "command", query: "sta" });

    act(() => view.root.render(<MarkdownComposer {...view.props} onTrigger={onTrigger} value="@src" />));
    expect(onTrigger).toHaveBeenLastCalledWith({ kind: "context", query: "src" });
    act(() => view.root.unmount());
    view.host.remove();
  });
});
