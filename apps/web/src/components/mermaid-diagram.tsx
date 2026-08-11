import { useEffect, useId, useState } from "react";

type MermaidDiagramProps = {
  source: string;
  theme: "paper" | "carbon";
};

export function MermaidDiagram({ source, theme }: MermaidDiagramProps) {
  const reactId = useId();
  const [markup, setMarkup] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;

    async function renderDiagram() {
      try {
        const { default: mermaid } = await import("mermaid");
        mermaid.initialize({
          securityLevel: "strict",
          startOnLoad: false,
          theme: theme === "carbon" ? "dark" : "neutral",
        });
        const id = `mermaid-${reactId.replaceAll(":", "")}`;
        const result = await mermaid.render(id, source);
        if (!active) return;
        setMarkup(result.svg);
        setError("");
      } catch (cause) {
        if (!active) return;
        setMarkup("");
        setError(cause instanceof Error ? cause.message : "Unable to render diagram");
      }
    }

    void renderDiagram();
    return () => {
      active = false;
    };
  }, [reactId, source, theme]);

  if (error) {
    return <div className="my-3 max-w-full overflow-auto rounded-lg border border-current/15 p-3">
      <p className="mb-2 text-xs opacity-70">Diagram could not be rendered</p>
      <pre className="whitespace-pre-wrap font-mono text-xs leading-6">{source}</pre>
    </div>;
  }

  return <div
    aria-label="Mermaid diagram"
    className="my-3 max-w-full overflow-auto rounded-lg border border-current/15 p-4 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
    dangerouslySetInnerHTML={{ __html: markup }}
    role="img"
  />;
}
