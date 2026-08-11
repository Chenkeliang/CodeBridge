import { Bot, Code2, MousePointer2, Sparkles } from "lucide-react";

const icons = {
  pi: Sparkles,
  codex: Code2,
  cursor: MousePointer2,
  claude: Bot,
} as const;

export function AgentIcon({ agentId, className = "size-4" }: { agentId: string; className?: string }) {
  const Icon = icons[agentId as keyof typeof icons] ?? Bot;
  return <Icon aria-hidden="true" className={className} strokeWidth={1.7} />;
}
