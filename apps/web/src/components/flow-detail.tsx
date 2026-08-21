import { X } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { revisionTail } from "@/lib/revision-tail";
import type { FlowRecord } from "@/lib/types";
import { cn } from "@/lib/utils";

export interface MissingInput {
  id: string;
  type: string;
  source: string;
  reason: string;
}

export function FlowDetail(props: {
  flow: FlowRecord;
  values: Record<string, unknown>;
  missing: MissingInput[];
  onValues: (values: Record<string, unknown>) => void;
  onSubmit: (values: Record<string, unknown>, dryRun: boolean) => void;
  onBind?: (flow: FlowRecord) => void;
  management?: ReactNode;
  onClose: () => void;
}) {
  const { flow, values } = props;
  const missingIds = new Set(props.missing.map((entry) => entry.id));

  return <section className="grid max-w-[760px] gap-3 rounded-lg border border-line bg-surface p-4 shadow-card">
    <header className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="flex items-center gap-2 text-sm font-semibold text-ink">
          <span>{flow.name || flow.flow_id}</span>
          <span className={cn("rounded px-1.5 py-0.5 font-mono text-xs", flow.status === "published" ? "bg-success-soft text-success" : "bg-warning-soft text-warning")}>{flow.status}</span>
        </p>
        <p className="mt-1 font-mono text-xs text-faint">
          {flow.kind} · rev {revisionTail(flow.definition_revision)}
          {flow.plan_ir_hash ? ` · plan ${revisionTail(flow.plan_ir_hash)}` : ""}
        </p>
      </div>
      <Button aria-label="关闭" onClick={props.onClose} size="sm" variant="ghost"><X className="size-3.5" /></Button>
    </header>

    {props.management}

    <ol className="grid gap-1">
      {flow.steps.map((step) => (
        <li className="grid grid-cols-[auto_1fr_auto] items-center gap-2 font-mono text-xs" key={step.id}>
          <span className="text-faint">{step.depends_on.length ? `↳ ${step.depends_on.join(",")} →` : "→"}</span>
          <span className="text-ink-soft">{step.capability ?? step.id}</span>
          <span className="text-faint">{step.success_when ?? ""}</span>
        </li>
      ))}
    </ol>

    <form
      className="grid gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit(values, flow.status === "candidate");
      }}
    >
      {flow.inputs.map((input) => (
        <label className="grid gap-1" key={input.id}>
          <span className="flex items-center gap-2 text-xs text-muted">
            {input.id}
            {input.required && <span className="text-danger">必填</span>}
            {input.source !== "user" && <span className="font-mono text-faint">{input.source}</span>}
          </span>
          <input
            aria-label={input.id}
            className={cn(
              "h-9 rounded-md border bg-surface-tint px-3 font-mono text-xs text-ink-soft outline-none focus:border-control-accent",
              missingIds.has(input.id) ? "border-danger" : "border-line",
            )}
            value={String(values[input.id] ?? "")}
            onChange={(event) => props.onValues({ ...values, [input.id]: event.target.value })}
          />
          {missingIds.has(input.id) && <span className="text-xs text-danger">缺少必填参数</span>}
        </label>
      ))}
      <div className="flex gap-2">
        {flow.kind === "runbook" && flow.status === "published" && (
          <>
            <Button className="h-8 text-xs" size="sm" type="submit">运行一次</Button>
            <Button className="h-8 text-xs" onClick={() => props.onBind?.(flow)} size="sm" type="button" variant="outline">绑定到会话</Button>
          </>
        )}
        {flow.kind === "runbook" && flow.status === "candidate" && (
          <Button className="h-8 text-xs" size="sm" type="submit" variant="outline">Dry-run 预演</Button>
        )}
      </div>
    </form>
  </section>;
}
