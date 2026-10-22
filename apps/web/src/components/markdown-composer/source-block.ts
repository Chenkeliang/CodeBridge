import { mergeAttributes, Node } from "@tiptap/core";

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
