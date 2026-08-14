import { Extension } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import { createMarkdownCodec } from "./markdown-codec";
import { SourceBlock } from "./source-block";

export type ComposerTrigger = {
  kind: "command" | "context";
  query: string;
} | null;

export type ComposerPickerKey = {
  key: "Escape" | "ArrowUp" | "ArrowDown" | "Enter" | "Tab";
  shiftKey: boolean;
};

type MarkdownComposerProps = {
  disabled: boolean;
  value: string;
  onChange: (markdown: string) => void;
  onFiles: (files: File[]) => Promise<void>;
  onPickerKey: (event: ComposerPickerKey) => boolean;
  onSerializationError: (message: string | null) => void;
  onSubmit: () => void;
  onTrigger: (trigger: ComposerTrigger) => void;
};

export function MarkdownComposer(props: MarkdownComposerProps) {
  const codec = useMemo(() => createMarkdownCodec(), []);
  const callbacks = useRef(props);
  callbacks.current = props;
  const lastEmitted = useRef(props.value);
  const initialContent = useRef(codec.parseSafely(props.value));

  const composerEvents = useMemo(() => Extension.create({
    name: "composerEvents",

    addProseMirrorPlugins() {
      return [new Plugin({
        props: {
          handleKeyDown: (_view, event) => {
            if (event.isComposing || this.editor.view.composing) return false;
            if (event.key === "Enter" && event.shiftKey) {
              return this.editor.commands.setHardBreak();
            }
            if (isPickerKey(event.key)) {
              if (callbacks.current.onPickerKey({ key: event.key, shiftKey: event.shiftKey })) return true;
              if (event.key !== "Enter") return false;
            }
            if (event.key === "Enter") {
              callbacks.current.onSubmit();
              return true;
            }
            return false;
          },
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
  }), [codec]);

  const editor = useEditor({
    content: initialContent.current.document,
    editable: !props.disabled,
    editorProps: {
      attributes: {
        "aria-label": "消息",
        "aria-multiline": "true",
        role: "textbox",
      },
    },
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      SourceBlock,
      Markdown,
      Placeholder.configure({ placeholder: "输入目标，或继续当前工作…" }),
      composerEvents,
    ],
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => {
      try {
        const markdown = codec.serialize(current.getJSON());
        lastEmitted.current = markdown;
        callbacks.current.onSerializationError(null);
        callbacks.current.onChange(markdown);
        callbacks.current.onTrigger(triggerAtEnd(markdown));
      } catch (error) {
        callbacks.current.onSerializationError(
          error instanceof Error ? error.message : "Markdown 序列化失败",
        );
      }
    },
  }, [composerEvents]);

  useEffect(() => {
    editor?.setEditable(!props.disabled);
  }, [editor, props.disabled]);

  useEffect(() => {
    if (!editor || props.value === lastEmitted.current) return;
    const parsed = codec.parseSafely(props.value);
    editor.commands.setContent(parsed.document, { emitUpdate: false });
    lastEmitted.current = props.value;
    props.onTrigger(triggerAtEnd(props.value));
    props.onSerializationError(null);
  }, [codec, editor, props.onSerializationError, props.onTrigger, props.value]);

  return <EditorContent className="markdown-composer" data-composer-editor editor={editor} />;
}

function isPickerKey(key: string): key is ComposerPickerKey["key"] {
  return key === "Escape"
    || key === "ArrowUp"
    || key === "ArrowDown"
    || key === "Enter"
    || key === "Tab";
}

function triggerAtEnd(markdown: string): ComposerTrigger {
  const match = markdown.match(/(?:^|\s)([/@])([^\s]*)$/);
  if (!match) return null;
  return {
    kind: match[1] === "/" ? "command" : "context",
    query: match[2] ?? "",
  };
}
