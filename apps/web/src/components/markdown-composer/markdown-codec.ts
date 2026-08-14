import type { JSONContent } from "@tiptap/core";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import { MarkdownManager } from "@tiptap/markdown";
import StarterKit from "@tiptap/starter-kit";
import { SourceBlock, type SourceBlockKind } from "./source-block";

const sentinelLanguage = "codebridge-source";
const encodedSourcePattern = /```codebridge-source\n([A-Za-z0-9+/=]+)\n```/g;

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

function fencedSourceKind(source: string): SourceBlockKind {
  return /^```mermaid(?:\s|$)/.test(source) ? "mermaid" : "code";
}

function protectUnsupportedBlocks(markdown: string): string {
  const lines = markdown.split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? "";
    if (/^```/.test(line)) {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        block.push(next);
        index += 1;
        if (/^```/.test(next)) break;
      }
      const source = block.join("\n");
      output.push(sourceSentinel(fencedSourceKind(source), source));
      continue;
    }

    if (line.trim() === "$$") {
      const block = [line];
      index += 1;
      while (index < lines.length) {
        const next = lines[index] ?? "";
        block.push(next);
        index += 1;
        if (next.trim() === "$$") break;
      }
      output.push(sourceSentinel("math", block.join("\n")));
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
      output.push(sourceSentinel("table", block.join("\n")));
      continue;
    }

    output.push(line);
    index += 1;
  }

  return output.join("\n");
}

function sourceSentinel(kind: SourceBlockKind, source: string): string {
  return `\`\`\`${sentinelLanguage}\n${encodeSource(kind, source)}\n\`\`\``;
}

function mapDocument(node: JSONContent, mapper: (value: JSONContent) => JSONContent): JSONContent {
  const mapped = {
    ...node,
    content: node.content?.map((child) => mapDocument(child, mapper)),
  };
  return mapper(mapped);
}

export function createMarkdownCodec() {
  const manager = new MarkdownManager({
    extensions: [
      StarterKit,
      TaskList,
      TaskItem.configure({ nested: true }),
      SourceBlock,
    ],
  });

  function parse(markdown: string): JSONContent {
    const document = manager.parse(protectUnsupportedBlocks(markdown));
    return mapDocument(document, (node) => {
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
      return {
        type: "codeBlock",
        attrs: { language: sentinelLanguage },
        content: [{ type: "text", text: encodeSource(node.attrs?.kind as SourceBlockKind, source) }],
      };
    });
    return manager.serialize(protectedDocument).replace(
      encodedSourcePattern,
      (_, encoded: string) => decodeSource(encoded).source,
    ).trimEnd();
  }

  return {
    parse,
    parseSafely(markdown: string, parser = parse): ParseResult {
      try {
        return { document: parser(markdown), failed: false };
      } catch {
        return { document: sourceDocument(markdown), failed: true };
      }
    },
    serialize,
  };
}
