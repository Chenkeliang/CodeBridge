import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, LoaderCircle, Pencil, Plug, Plus, Trash2, X, Zap } from "lucide-react";
import { api } from "@/lib/api";
import type { AgentProfile, AgentSetupManifest, PiProvider, PiProviderModel, PiProviderPreset } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type Density } from "@/components/workbench-shared";

/** Settings surface (docs/orchestration/agent-providers.md §2.7): Pi provider
 *  management with vendor presets, plus display preferences. */

const API_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];

/** Context window presets; 1M entries reflect 2026 flagship models. The value
 *  is a declaration — actual availability is enforced by the provider/gateway. */
const CONTEXT_PRESETS: Array<[string, number]> = [
  ["128K", 128000],
  ["200K", 200000],
  ["272K", 272000],
  ["1M", 1000000],
];
const DEFAULT_LEVEL_MAP = { off: "none", minimal: "minimal", low: "low", medium: "medium", high: "high" };

type ProvidersFile = { providers: Record<string, PiProvider> };

interface ProviderDraft {
  id: string;
  baseUrl: string;
  api: string;
  apiKey: string;
  authHeader: boolean;
  models: PiProviderModel[];
  /** Fields we don't edit in the form are preserved verbatim on save. */
  passthrough: Record<string, unknown>;
}

export function SettingsPage({ density, reading, onDensity, onReading, onNotify, agents, defaultAgentId, effectiveDefaultAgentId, onAgentsChanged, onProvidersChanged }: {
  density: Density;
  reading: boolean;
  onDensity: (density: Density) => void;
  onReading: (reading: boolean) => void;
  onNotify: (message: string, kind?: "info" | "error") => void;
  agents: AgentProfile[];
  defaultAgentId: string | null;
  effectiveDefaultAgentId: string | null;
  onAgentsChanged: () => Promise<void>;
  onProvidersChanged: () => void;
}) {
  const [providers, setProviders] = useState<Record<string, PiProvider> | null>(null);
  const [presets, setPresets] = useState<PiProviderPreset[]>([]);
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [editingOriginalId, setEditingOriginalId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [agentAction, setAgentAction] = useState<{ id: string; kind: "detect" | "install" | "default" } | null>(null);
  const [agentErrors, setAgentErrors] = useState<Record<string, string | null>>({});

  const load = useCallback(async () => {
    try {
      const [file, presetList] = await Promise.all([api.providers(), api.providerPresets()]);
      setProviders(file);
      setPresets(presetList);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const agentCards = agents.filter((agent) => agent.setup_manifest);
  const effectiveDefaultAgent = agents.find((agent) => agent.agent_id === effectiveDefaultAgentId) ?? null;
  const savedDefaultUnavailable = Boolean(defaultAgentId && defaultAgentId !== effectiveDefaultAgentId);

  async function refreshAgents() {
    await onAgentsChanged();
  }

  function setAgentError(agentId: string, message: string | null) {
    setAgentErrors((current) => ({ ...current, [agentId]: message }));
  }

  async function detectAgent(agent: AgentProfile) {
    setAgentAction({ id: agent.agent_id, kind: "detect" });
    setAgentError(agent.agent_id, null);
    try {
      await api.detectAgent(agent.agent_id);
      await refreshAgents();
      onNotify(`${agent.display_name} 已重新检测`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setAgentError(agent.agent_id, message);
      await refreshAgents();
      onNotify(message, "error");
    } finally {
      setAgentAction(null);
    }
  }

  async function installAgent(agent: AgentProfile, manifest: AgentSetupManifest) {
    const strategy = manifest.install_strategies.find((candidate) => candidate.available) ?? manifest.install_strategies[0];
    if (!strategy) {
      onNotify(`${manifest.display_name} 没有可用的安装策略`, "error");
      return;
    }
    const command = [strategy.command, ...strategy.args].join(" ");
    if (!window.confirm(`将执行以下安装命令：\n\n${command}\n\n继续吗？`)) return;
    setAgentAction({ id: agent.agent_id, kind: "install" });
    setAgentError(agent.agent_id, null);
    try {
      await api.installAgent(agent.agent_id, strategy.id);
      await refreshAgents();
      onNotify(`${manifest.display_name} 安装已完成`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setAgentError(agent.agent_id, message);
      await refreshAgents();
      onNotify(message, "error");
    } finally {
      setAgentAction(null);
    }
  }

  async function setDefault(agent: AgentProfile) {
    setAgentAction({ id: agent.agent_id, kind: "default" });
    setAgentError(agent.agent_id, null);
    try {
      await api.setDefaultAgent(agent.agent_id);
      await refreshAgents();
      onNotify(`${agent.display_name} 已设为默认`);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setAgentError(agent.agent_id, message);
      onNotify(message, "error");
    } finally {
      setAgentAction(null);
    }
  }

  function startAdd(preset: PiProviderPreset | null) {
    setEditingOriginalId(null);
    setEditing(preset ? {
      id: preset.id,
      baseUrl: preset.baseUrl,
      api: preset.api,
      apiKey: "",
      authHeader: true,
      models: preset.models.map((model) => ({ ...model })),
      passthrough: {},
    } : {
      id: "", baseUrl: "", api: "openai-completions", apiKey: "", authHeader: true, models: [], passthrough: {},
    });
  }

  function startEdit(id: string, provider: PiProvider) {
    const { baseUrl, api: protocol, apiKey, authHeader, models, ...rest } = provider;
    setEditingOriginalId(id);
    setEditing({
      id,
      baseUrl,
      api: protocol,
      apiKey: apiKey ?? "",
      authHeader: authHeader ?? true,
      models: (models ?? []).map((model) => ({ ...model })),
      passthrough: rest,
    });
  }

  async function save() {
    if (!editing || !providers) return;
    setSaving(true);
    setSaveError(null);
    try {
      const next: ProvidersFile = { providers: { ...providers } };
      if (editingOriginalId && editingOriginalId !== editing.id) delete next.providers[editingOriginalId];
      next.providers[editing.id] = {
        ...editing.passthrough,
        baseUrl: editing.baseUrl,
        api: editing.api,
        apiKey: editing.apiKey,
        authHeader: editing.authHeader,
        models: editing.models,
      };
      await api.saveProviders(next);
      setProviders(next.providers);
      setEditing(null);
      onProvidersChanged();
      onNotify("Provider 已保存");
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string) {
    if (!providers) return;
    const next: ProvidersFile = { providers: { ...providers } };
    delete next.providers[id];
    try {
      await api.saveProviders(next);
      setProviders(next.providers);
      setDeleting(null);
      onNotify(`已删除 ${id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function test() {
    if (!editing) return;
    setTesting(true);
    try {
      const result = await api.testProvider({ baseUrl: editing.baseUrl, apiKey: editing.apiKey, authHeader: editing.authHeader });
      onNotify(result.detail, result.ok ? "info" : "error");
    } catch (caught) {
      onNotify(caught instanceof Error ? caught.message : String(caught), "error");
    } finally {
      setTesting(false);
    }
  }

  return <div className="mx-auto w-full max-w-[760px] px-8 py-8">
    <h1 className={cn("font-brand text-lg font-normal tracking-[-0.035em]", "text-ink")}>设置</h1>

    {error && <div className={cn("mt-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs", "bg-danger-soft", "text-danger", "border-line-strong")} role="alert"><X className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 flex-1">{error}</span></div>}

    <section className="mt-8">
      <div className="flex items-center justify-between gap-3">
        <h2 className={cn("font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-faint")}>AGENTS</h2>
        {savedDefaultUnavailable && (
          <span className={cn("rounded-full border px-2 py-1 text-[11px]", "bg-warning-soft", "text-warning", "border-warning/30")}>
            默认 Agent 当前不可用{effectiveDefaultAgent ? ` · 正在使用 ${effectiveDefaultAgent.display_name}` : ""}
          </span>
        )}
      </div>
      <div className="mt-4 grid gap-2">
        {agentCards.map((agent) => {
          const setup = agent.setup;
          const manifest = agent.setup_manifest as AgentSetupManifest;
          const isSavedDefault = defaultAgentId === agent.agent_id;
          const isEffectiveDefault = effectiveDefaultAgentId === agent.agent_id;
          const busy = agentAction?.id === agent.agent_id;
          const diagnostic = setup?.diagnostic;
          const primaryStrategy = manifest.install_strategies.find((strategy) => strategy.available) ?? manifest.install_strategies[0] ?? null;
          return <div className={cn("grid gap-3 rounded-xl border px-4 py-4", "bg-surface", "border-line-strong")} key={agent.agent_id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className={cn("flex flex-wrap items-center gap-2", "text-ink")}>
                  <span className="font-brand text-sm font-normal tracking-[-0.02em]">{manifest.display_name}</span>
                  {isSavedDefault && <span className={cn("rounded-full border px-2 py-0.5 text-[10px]", "bg-accent-soft", "text-accent", "border-line-strong")}>已保存默认</span>}
                  {!isSavedDefault && isEffectiveDefault && <span className={cn("rounded-full border px-2 py-0.5 text-[10px]", "bg-success-soft", "text-success", "border-line-strong")}>当前生效默认</span>}
                </div>
                <div className={cn("mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs", "text-muted")}>
                  <span>{setupInstallationLabel(setup)}</span>
                  <span>{setupConfigurationLabel(setup)}</span>
                  <span>{setupRuntimeLabel(setup)}</span>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button className={cn("rounded-full border px-2 py-1 text-[11px]", "border-line-strong", "text-muted", busy && "opacity-50")} disabled={busy} onClick={() => void detectAgent(agent)} type="button">
                  {agentAction?.id === agent.agent_id && agentAction.kind === "detect" ? "检测中…" : "重新检测"}
                </button>
                <button className={cn("rounded-full border px-2 py-1 text-[11px]", "border-line-strong", "text-muted", !setup?.can_select_default && "opacity-40", busy && "opacity-50")} disabled={!setup?.can_select_default || busy} onClick={() => void setDefault(agent)} type="button">
                  {isSavedDefault ? "当前默认" : "设为默认"}
                </button>
              </div>
            </div>

            <div className={cn("grid gap-2 rounded-lg border px-3 py-3", "bg-surface-soft", "border-line")}>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className={cn("rounded-full px-2 py-0.5", setup?.installation === "installed" ? "bg-success-soft text-success" : setup?.installation === "missing" ? "bg-danger-soft text-danger" : "bg-surface text-muted")}>
                  {setupInstallationLabel(setup)}
                </span>
                <span className={cn("rounded-full px-2 py-0.5", setup?.configuration === "configured" ? "bg-success-soft text-success" : setup?.configuration === "needs_configuration" ? "bg-warning-soft text-warning" : "bg-surface text-muted")}>
                  {setupConfigurationLabel(setup)}
                </span>
                <span className={cn("rounded-full px-2 py-0.5", setup?.runtime === "healthy" ? "bg-success-soft text-success" : setup?.runtime === "unavailable" ? "bg-danger-soft text-danger" : "bg-surface text-muted")}>
                  {setupRuntimeLabel(setup)}
                </span>
                {setup?.version && <span className="text-muted">版本 {setup.version}</span>}
              </div>
              <div className="text-xs leading-5 text-muted">
                <div>{manifest.configuration_owner === "codebridge" ? "CodeBridge 管理该 Agent 的配置入口。" : manifest.documentation_url ? "打开官方文档完成配置。" : "该 Agent 由自身配置入口管理。"}</div>
                {manifest.configuration_path && <div className="font-mono">{manifest.configuration_path}</div>}
                {primaryStrategy && setup?.installation === "missing" && (
                  <div className="mt-1 text-[11px]">
                    安装命令: <span className="font-mono">{[primaryStrategy.command, ...primaryStrategy.args].join(" ")}</span>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {setup?.installation === "missing" && primaryStrategy ? (
                  <button className={cn("rounded-md border px-3 py-1.5 text-xs", "bg-accent", "text-accent-ink", "border-line-strong", busy && "opacity-50")} disabled={busy} onClick={() => void installAgent(agent, manifest)} type="button">
                    {agentAction?.id === agent.agent_id && agentAction.kind === "install" ? "安装中…" : `安装 ${manifest.display_name}`}
                  </button>
                ) : null}
                {manifest.configuration_owner === "codebridge" ? (
                  <button className={cn("rounded-md border px-3 py-1.5 text-xs", "bg-surface", "text-ink", "border-line-strong")} onClick={() => {
                    document.getElementById("providers-pi")?.scrollIntoView({ behavior: "smooth", block: "start" });
                  }} type="button">
                    前往 Providers(Pi)
                  </button>
                ) : manifest.documentation_url ? (
                  <button className={cn("rounded-md border px-3 py-1.5 text-xs", "bg-surface", "text-ink", "border-line-strong")} onClick={() => window.open(manifest.documentation_url, "_blank", "noopener")} type="button">
                    {setup?.configuration === "needs_configuration" ? "查看配置方法" : "打开文档"}
                  </button>
                ) : null}
              </div>
            </div>

            {(diagnostic || agentErrors[agent.agent_id]) && (
              <div className={cn("rounded-lg border px-3 py-2 text-xs", "bg-danger-soft", "text-danger", "border-danger/30")}>
                {diagnostic && <>
                  <div className="font-medium">{diagnostic.stage} · {diagnostic.code}</div>
                  <div className="mt-1 leading-5">{diagnostic.message}</div>
                  {diagnostic.details && <div className="mt-1 font-mono leading-5 text-[11px]">{diagnostic.details}</div>}
                  {diagnostic.exit_code !== undefined && <div className="mt-1 font-mono text-[11px]">exit code: {diagnostic.exit_code}</div>}
                </>}
                {agentErrors[agent.agent_id] && <div className={diagnostic ? "mt-1" : ""}>{agentErrors[agent.agent_id]}</div>}
              </div>
            )}
          </div>;
        })}
      </div>
    </section>

    <section className="mt-8">
      <div className="flex items-center justify-between">
        <h2 className={cn("font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-faint")} id="providers-pi">Providers(Pi)</h2>
      </div>
      <p className={cn("mt-1.5 text-xs leading-5", "text-muted")}>管理 Pi 的模型供应商,写入本机 ~/.pi/agent/models.json。密钥仅保存在本机。</p>

      {providers === null ? (
        <div className={cn("mt-4 grid gap-2")}><div className={cn("skeleton-pixel h-14 animate-pulse rounded-lg", "bg-surface-soft")} /><div className={cn("skeleton-pixel h-14 animate-pulse rounded-lg", "bg-surface-soft")} /></div>
      ) : (
        <div className="mt-4 grid gap-2">
          {Object.entries(providers).map(([id, provider]) => (
            <div className={cn("flex items-center gap-3 rounded-lg border px-3.5 py-3", "bg-surface", "border-line")} key={id}>
              <Plug className={cn("size-4 shrink-0", "text-muted")} />
              <div className="min-w-0 flex-1">
                <div className={cn("flex items-center gap-2 text-sm font-medium", "text-ink")}>
                  <span className="font-mono">{id}</span>
                  <span className={cn("text-xs font-normal", provider.apiKey ? "text-success" : "text-warning")}>{provider.apiKey ? "已配置 key" : "缺 key"}</span>
                </div>
                <div className={cn("mt-0.5 truncate text-xs", "text-muted")}>{provider.baseUrl} · {provider.models?.length ?? 0} 个模型</div>
              </div>
              {deleting === id ? (
                <span className="flex items-center gap-1.5">
                  <span className={cn("text-xs", "text-danger")}>确认删除?</span>
                  <button className={cn("rounded-md border px-2 py-1 text-xs", "text-danger", "border-line-strong")} onClick={() => void remove(id)} type="button">删除</button>
                  <button className={cn("rounded-md px-2 py-1 text-xs", "text-muted")} onClick={() => setDeleting(null)} type="button">取消</button>
                </span>
              ) : (
                <span className="flex items-center gap-1">
                  <button aria-label={`编辑 ${id}`} className={cn("grid size-8 place-items-center rounded-md", "text-muted", "hover:bg-surface-soft")} onClick={() => startEdit(id, provider)} type="button"><Pencil className="size-3.5" /></button>
                  <button aria-label={`删除 ${id}`} className={cn("grid size-8 place-items-center rounded-md", "text-muted", "hover:bg-surface-soft")} onClick={() => setDeleting(id)} type="button"><Trash2 className="size-3.5" /></button>
                </span>
              )}
            </div>
          ))}
          {Object.keys(providers).length === 0 && <div className={cn("rounded-lg border border-dashed px-4 py-8 text-center text-xs", "border-line-strong", "text-muted")}>尚未配置 Provider,从下方预设开始</div>}

          <div className={cn("mt-2 flex flex-wrap gap-2")}>
            {presets.map((preset) => (
              <button className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition-colors", "bg-surface", "text-ink-soft", "border-line", "hover:bg-surface-soft")} key={preset.id} onClick={() => startAdd(preset)} type="button">
                <Plus className="size-3" />{preset.name}
              </button>
            ))}
            <button className={cn("flex items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs", "text-muted", "border-line-strong", "hover:bg-surface-soft")} onClick={() => startAdd(null)} type="button"><Plus className="size-3" />自定义</button>
          </div>
        </div>
      )}
    </section>

    <section className="mt-10">
      <h2 className={cn("font-brand text-xs font-normal uppercase tracking-[0.1em]", "text-faint")}>显示</h2>
      <div className={cn("mt-3 grid gap-3 rounded-lg border px-4 py-4", "bg-surface", "border-line")}>
        <div className="flex items-center justify-between gap-3">
          <span className={cn("text-xs", "text-ink-soft")}>对话密度</span>
          <div className={cn("flex rounded-md border p-0.5", "border-line")}>
            {(["compact", "comfortable"] as const).map((value) => (
              <button aria-pressed={density === value} className={cn("h-6 rounded px-2 text-xs transition-colors", density === value ? cn("bg-surface-soft", "text-ink") : "text-muted")} key={value} onClick={() => onDensity(value)} type="button">{value === "compact" ? "紧凑" : "舒展"}</button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <span className={cn("text-xs", "text-ink-soft")}>衬线阅读模式</span>
          <button aria-pressed={reading} className={cn("h-6 rounded-md border px-2 text-xs transition-colors", "border-line", reading ? cn("bg-surface-soft", "text-ink") : "text-muted")} onClick={() => onReading(!reading)} type="button">{reading ? "已开启" : "已关闭"}</button>
        </div>
      </div>
    </section>

    {editing && <ProviderEditor
      draft={editing}
      originalId={editingOriginalId}
      saveError={saveError}
      saving={saving}
      testing={testing}
      onChange={(next) => { setEditing(next); setSaveError(null); }}
      onClose={() => setEditing(null)}
      onSave={() => void save()}
      onTest={() => void test()}
    />}
  </div>;
}

const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9_-]*$/;

function ProviderEditor({ draft, originalId, saveError, saving, testing, onChange, onClose, onSave, onTest }: {
  draft: ProviderDraft;
  originalId: string | null;
  saveError: string | null;
  saving: boolean;
  testing: boolean;
  onChange: (draft: ProviderDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onTest: () => void;
}) {
  const idIssue = draft.id && !PROVIDER_ID_RE.test(draft.id)
    ? "ID 只能含小写字母/数字/连字符/下划线,且以字母或数字开头"
    : null;
  function patch(update: Partial<ProviderDraft>) {
    onChange({ ...draft, ...update });
  }
  function patchModel(index: number, update: Partial<PiProviderModel>) {
    const models = draft.models.map((model, i) => i === index ? { ...model, ...update } : model);
    patch({ models });
  }
  const canSave = draft.id.trim() && !idIssue && /^https?:\/\//.test(draft.baseUrl) && draft.apiKey.trim();

  return <div className="fixed inset-0 z-50 bg-canvas/80" onClick={onClose} role="dialog" aria-modal="true">
    <div className={cn("mx-auto mt-[6vh] max-h-[86vh] w-full max-w-[560px] overflow-y-auto rounded-xl border p-5", "bg-surface", "border-line-strong", "shadow-panel")} onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h3 className={cn("text-sm font-semibold", "text-ink")}>{originalId ? `编辑 Provider · ${originalId}` : "添加 Provider"}</h3>
        <button aria-label="关闭" className={cn("grid size-8 place-items-center rounded-md", "text-muted", "hover:bg-surface-soft")} onClick={onClose} type="button"><ChevronLeft className="size-4 rotate-90" /></button>
      </div>

      <div className="mt-4 grid gap-3">
        <Field label="ID(小写字母/数字/连字符/下划线)">
          <input aria-invalid={Boolean(idIssue)} className={cn(inputCls(), idIssue && "border-danger")} disabled={Boolean(originalId)} onChange={(e) => patch({ id: e.target.value.trim() })} placeholder="deepseek" value={draft.id} />
          {idIssue && <span className={cn("text-[11px]", "text-danger")}>{idIssue}</span>}
        </Field>
        <Field label="Base URL">
          <input className={inputCls()} onChange={(e) => patch({ baseUrl: e.target.value.trim() })} placeholder="https://api.deepseek.com/v1" value={draft.baseUrl} />
        </Field>
        <Field label="API 协议">
          <select className={inputCls()} onChange={(e) => patch({ api: e.target.value })} value={draft.api}>
            {API_PROTOCOLS.map((protocol) => <option key={protocol} value={protocol}>{protocol}</option>)}
          </select>
        </Field>
        <Field label="API Key(明文保存在本机 models.json)">
          <input className={inputCls()} onChange={(e) => patch({ apiKey: e.target.value })} placeholder="sk-…" value={draft.apiKey} />
        </Field>
        <label className={cn("flex items-center gap-2 text-xs", "text-ink-soft")}>
          <input checked={draft.authHeader} onChange={(e) => patch({ authHeader: e.target.checked })} type="checkbox" />
          使用 Authorization: Bearer 头(关闭则发 x-api-key)
        </label>

        <div className="mt-1 flex items-center justify-between">
          <span className={cn("font-brand text-xs font-normal uppercase tracking-[0.08em]", "text-faint")}>模型({draft.models.length})</span>
          <button className={cn("flex items-center gap-1 rounded-md border px-2 py-1 text-xs", "text-ink-soft", "border-line", "hover:bg-surface-soft")} onClick={() => patch({ models: [...draft.models, { id: "", reasoning: false, input: ["text"] }] })} type="button"><Plus className="size-3" />添加模型</button>
        </div>
        {draft.models.map((model, index) => (
          <div className={cn("grid gap-2 rounded-lg border p-3", "bg-surface-tint", "border-line")} key={index}>
            <div className="flex gap-2">
              <input aria-label="模型 id" className={cn(inputCls(), "flex-1")} onChange={(e) => patchModel(index, { id: e.target.value.trim() })} placeholder="模型 id,如 glm-4.6" value={model.id} />
              <button aria-label="移除模型" className={cn("grid size-8 shrink-0 place-items-center rounded-md", "text-muted", "hover:bg-surface-soft")} onClick={() => patch({ models: draft.models.filter((_, i) => i !== index) })} type="button"><Trash2 className="size-3.5" /></button>
            </div>
            <input aria-label="显示名" className={inputCls()} onChange={(e) => patchModel(index, { name: e.target.value })} placeholder="显示名(可选)" value={model.name ?? ""} />
            <div className="flex items-center gap-4 text-xs">
              <label className={cn("flex items-center gap-1.5", "text-ink-soft")}>
                <input checked={model.reasoning ?? false} onChange={(e) => patchModel(index, e.target.checked ? { reasoning: true, thinkingLevelMap: model.thinkingLevelMap ?? { ...DEFAULT_LEVEL_MAP } } : { reasoning: false, thinkingLevelMap: undefined })} type="checkbox" />
                支持推理(思考等级)
              </label>
              <label className={cn("flex items-center gap-1.5", "text-ink-soft")}>
                上下文
                <select className={cn(inputCls(), "w-28")} onChange={(e) => patchModel(index, { contextWindow: e.target.value === "custom" ? (model.contextWindow ?? 128000) : Number(e.target.value) || undefined })} value={CONTEXT_PRESETS.some(([, v]) => v === model.contextWindow) ? String(model.contextWindow) : model.contextWindow ? "custom" : "128000"}>
                  {CONTEXT_PRESETS.map(([label, value]) => <option key={value} value={value}>{label}</option>)}
                  {model.contextWindow && !CONTEXT_PRESETS.some(([, v]) => v === model.contextWindow) && <option value="custom">{Math.round(model.contextWindow / 1000)}K(自定义)</option>}
                </select>
              </label>
            </div>
          </div>
        ))}
      </div>

      {saveError && <div className={cn("mt-4 flex items-start gap-2 rounded-md border px-3 py-2.5 text-xs", "bg-danger-soft", "text-danger", "border-line-strong")} role="alert"><X className="mt-0.5 size-3.5 shrink-0" /><span className="min-w-0 flex-1 break-words">{saveError}</span></div>}

      <div className="mt-5 flex items-center gap-2">
        <button className={cn("flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs", "bg-accent", "text-accent-ink", "border-line-strong", (!canSave || saving) && "opacity-40")} disabled={!canSave || saving} onClick={onSave} type="button">
          {saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}保存
        </button>
        <button className={cn("flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs", "bg-surface", "text-ink", "border-line-strong")} disabled={!/^https?:\/\//.test(draft.baseUrl) || testing} onClick={onTest} type="button">
          {testing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}测试连接
        </button>
        <span className="flex-1" />
        <button className={cn("h-8 rounded-md px-3 text-xs", "text-muted")} onClick={onClose} type="button">取消</button>
      </div>
    </div>
  </div>;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="grid gap-1">
    <span className={cn("text-xs", "text-muted")}>{label}</span>
    {children}
  </label>;
}

function inputCls(): string {
  return cn("h-8 w-full rounded-md border bg-transparent px-2.5 text-xs outline-none", "text-ink", "border-line-strong", "placeholder:text-faint", "focus:border-muted focus-visible:ring-line-strong");
}

function setupInstallationLabel(setup: AgentProfile["setup"] | undefined): string {
  if (!setup) return "安装状态未知";
  if (setup.installation === "installed") return setup.version ? `已安装 · ${setup.version}` : "已安装";
  if (setup.installation === "missing") return "未安装";
  return "安装状态未知";
}

function setupConfigurationLabel(setup: AgentProfile["setup"] | undefined): string {
  if (!setup) return "配置状态未知";
  if (setup.configuration === "configured") return "已配置";
  if (setup.configuration === "needs_configuration") return "待配置";
  return "配置状态未知";
}

function setupRuntimeLabel(setup: AgentProfile["setup"] | undefined): string {
  if (!setup) return "运行状态未知";
  if (setup.runtime === "healthy") return "运行正常";
  if (setup.runtime === "unavailable") return "运行不可用";
  return "未启动";
}
