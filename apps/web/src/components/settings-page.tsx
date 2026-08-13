import { useCallback, useEffect, useState } from "react";
import { Check, ChevronLeft, LoaderCircle, Pencil, Plug, Plus, Trash2, X, Zap } from "lucide-react";
import { api } from "@/lib/api";
import type { PiProvider, PiProviderModel, PiProviderPreset } from "@/lib/types";
import { cn } from "@/lib/utils";
import { type Density } from "@/components/workbench-shared";

/** Settings surface (docs/orchestration/agent-providers.md §2.7): Pi provider
 *  management with vendor presets, plus display preferences. */

const API_PROTOCOLS = ["openai-completions", "openai-responses", "anthropic-messages"];
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

export function SettingsPage({ density, reading, onDensity, onReading, onNotify }: {
  density: Density;
  reading: boolean;
  onDensity: (density: Density) => void;
  onReading: (reading: boolean) => void;
  onNotify: (message: string, kind?: "info" | "error") => void;
}) {
  const [providers, setProviders] = useState<Record<string, PiProvider> | null>(null);
  const [presets, setPresets] = useState<PiProviderPreset[]>([]);
  const [editing, setEditing] = useState<ProviderDraft | null>(null);
  const [editingOriginalId, setEditingOriginalId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
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
      onNotify("Provider 已保存");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
      <div className="flex items-center justify-between">
        <h2 className={cn("text-xs font-semibold uppercase tracking-[0.1em]", "text-faint")}>Providers(Pi)</h2>
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
      <h2 className={cn("text-xs font-semibold uppercase tracking-[0.1em]", "text-faint")}>显示</h2>
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
      saving={saving}
      testing={testing}
      onChange={setEditing}
      onClose={() => setEditing(null)}
      onSave={() => void save()}
      onTest={() => void test()}
    />}
  </div>;
}

function ProviderEditor({ draft, originalId, saving, testing, onChange, onClose, onSave, onTest }: {
  draft: ProviderDraft;
  originalId: string | null;
  saving: boolean;
  testing: boolean;
  onChange: (draft: ProviderDraft) => void;
  onClose: () => void;
  onSave: () => void;
  onTest: () => void;
}) {
  function patch(update: Partial<ProviderDraft>) {
    onChange({ ...draft, ...update });
  }
  function patchModel(index: number, update: Partial<PiProviderModel>) {
    const models = draft.models.map((model, i) => i === index ? { ...model, ...update } : model);
    patch({ models });
  }
  const canSave = draft.id.trim() && /^https?:\/\//.test(draft.baseUrl) && draft.apiKey.trim();

  return <div className="fixed inset-0 z-50 bg-canvas/80" onClick={onClose} role="dialog" aria-modal="true">
    <div className={cn("mx-auto mt-[6vh] max-h-[86vh] w-full max-w-[560px] overflow-y-auto rounded-xl border p-5", "bg-surface", "border-line-strong", "shadow-panel")} onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center justify-between">
        <h3 className={cn("text-sm font-semibold", "text-ink")}>{originalId ? `编辑 Provider · ${originalId}` : "添加 Provider"}</h3>
        <button aria-label="关闭" className={cn("grid size-8 place-items-center rounded-md", "text-muted", "hover:bg-surface-soft")} onClick={onClose} type="button"><ChevronLeft className="size-4 rotate-90" /></button>
      </div>

      <div className="mt-4 grid gap-3">
        <Field label="ID(小写字母/数字/连字符)">
          <input className={inputCls()} disabled={Boolean(originalId)} onChange={(e) => patch({ id: e.target.value.trim() })} placeholder="deepseek" value={draft.id} />
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
          <span className={cn("text-xs font-semibold uppercase tracking-[0.08em]", "text-faint")}>模型({draft.models.length})</span>
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
                <input className={cn(inputCls(), "w-24")} inputMode="numeric" onChange={(e) => patchModel(index, { contextWindow: Number(e.target.value) || undefined })} placeholder="200000" value={model.contextWindow ?? ""} />
              </label>
            </div>
          </div>
        ))}
      </div>

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
