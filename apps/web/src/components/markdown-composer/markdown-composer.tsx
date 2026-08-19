import { Extension, type Editor, type JSONContent } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { Markdown } from "@tiptap/markdown";
import { Plugin } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useState } from "react";
import { composerTrigger } from "@/lib/workbench-logic";
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

type MarkdownComposerCallbacks = Omit<MarkdownComposerProps, "disabled" | "value">;
type MarkdownCodec = ReturnType<typeof createMarkdownCodec>;
type ComposerEventsStorage = {
  blockedMarkdown: string | null;
  callbacks: MarkdownComposerCallbacks | null;
  codec: MarkdownCodec | null;
  initialized: boolean;
  lastEmitted: string;
};

type ComposerRuntime = {
  callbacks: MarkdownComposerCallbacks;
  codec: MarkdownCodec;
  value: string;
};

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    composerEvents: {
      syncComposerRuntime: (runtime: ComposerRuntime) => ReturnType;
    };
  }

  interface Storage {
    composerEvents: ComposerEventsStorage;
  }
}

const ComposerEvents = Extension.create<Record<string, never>, ComposerEventsStorage>({
  name: "composerEvents",

  addStorage() {
    return {
      blockedMarkdown: null,
      callbacks: null,
      codec: null,
      initialized: false,
      lastEmitted: "",
    };
  },

  addCommands() {
    return {
      syncComposerRuntime: (runtime) => ({ commands }) => {
        this.storage.callbacks = runtime.callbacks;
        this.storage.codec = runtime.codec;
        const current = runtime.codec.serialize(this.editor.getJSON());
        const aligned = current.trim() === runtime.value.trim();
        if (!this.storage.initialized) {
          this.storage.initialized = true;
          this.storage.lastEmitted = runtime.value;
          if (aligned) return true;
        } else if (runtime.value === this.storage.lastEmitted && aligned) {
          return true;
        }
        if (!runtime.value.trim()) this.storage.blockedMarkdown = current;
        else this.storage.blockedMarkdown = null;
        const parsed = runtime.codec.parseSafely(runtime.value);
        commands.setContent(parsed.document, { emitUpdate: false });
        this.storage.lastEmitted = runtime.value;
        runtime.callbacks.onTrigger(triggerFromDocument(parsed.document, runtime.value));
        runtime.callbacks.onSerializationError(null);
        return true;
      },
    };
  },

  addProseMirrorPlugins() {
    return [new Plugin({
      props: {
        handleKeyDown: (_view, event) => {
          const callbacks = this.storage.callbacks;
          if (!callbacks || event.isComposing || this.editor.view.composing) return false;
          if (event.key === "Enter" && this.editor.state.selection.$from.parent.type.name === "sourceBlock") {
            return false;
          }
          if (event.key === "Enter" && event.shiftKey) {
            return this.editor.commands.setHardBreak();
          }
          if (isPickerKey(event.key)) {
            if (callbacks.onPickerKey({ key: event.key, shiftKey: event.shiftKey })) return true;
            if (event.key !== "Enter") return false;
          }
          if (event.key === "Enter") {
            callbacks.onSubmit();
            return true;
          }
          return false;
        },
        handlePaste: (_view, event) => {
          const { callbacks, codec } = this.storage;
          if (!callbacks || !codec) return false;
          const files = Array.from(event.clipboardData?.files ?? []);
          if (files.length) void callbacks.onFiles(files);
          const text = event.clipboardData?.getData("text/plain") ?? "";
          if (!text) return files.length > 0;
          const parsed = codec.parseSafely(text);
          this.editor.commands.insertContent(parsed.document.content ?? []);
          return true;
        },
      },
    })];
  },
});

export function MarkdownComposer({
  disabled,
  value,
  onChange,
  onFiles,
  onPickerKey,
  onSerializationError,
  onSubmit,
  onTrigger,
}: MarkdownComposerProps) {
  const codec = useMemo(() => createMarkdownCodec(), []);
  const [initialContent] = useState(() => codec.parseSafely(value).document);
  const extensions = useMemo(() => [
    StarterKit,
    TaskList,
    TaskItem.configure({ nested: true }),
    SourceBlock,
    Markdown,
    Placeholder.configure({ placeholder: "输入目标，或继续当前工作…" }),
    ComposerEvents,
  ], []);

  const editor = useEditor({
    content: initialContent,
    editable: !disabled,
    editorProps: {
      attributes: {
        "aria-label": "消息",
        "aria-multiline": "true",
        role: "textbox",
      },
    },
    extensions,
    immediatelyRender: false,
    onUpdate: ({ editor: current }) => {
      const storage = current.storage.composerEvents as ComposerEventsStorage;
      if (!storage.callbacks || !storage.codec) return;
      try {
        const document = current.getJSON();
        const markdown = storage.codec.serialize(document);
        if (
          storage.blockedMarkdown !== null
          && markdown.trim() === storage.blockedMarkdown.trim()
        ) return;
        storage.blockedMarkdown = null;
        storage.lastEmitted = markdown;
        storage.callbacks.onSerializationError(null);
        storage.callbacks.onChange(markdown);
        storage.callbacks.onTrigger(triggerFromEditor(current, markdown));
      } catch (error) {
        storage.callbacks.onSerializationError(
          error instanceof Error ? error.message : "Markdown 序列化失败",
        );
      }
    },
  }, [extensions, initialContent]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    if (!editor) return;
    editor.commands.syncComposerRuntime({
      callbacks: {
        onChange,
        onFiles,
        onPickerKey,
        onSerializationError,
        onSubmit,
        onTrigger,
      },
      codec,
      value,
    });
  }, [
    codec,
    editor,
    onChange,
    onFiles,
    onPickerKey,
    onSerializationError,
    onSubmit,
    onTrigger,
    value,
  ]);

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
  return composerTrigger(markdown);
}

function triggerFromDocument(document: JSONContent, markdown: string): ComposerTrigger {
  return document.content?.at(-1)?.type === "sourceBlock" ? null : triggerAtEnd(markdown);
}

function triggerFromEditor(editor: Editor, markdown: string): ComposerTrigger {
  return editor.state.selection.$from.parent.type.name === "sourceBlock"
    ? null
    : triggerAtEnd(markdown);
}
