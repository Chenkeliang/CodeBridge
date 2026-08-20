/** Generic third-party model endpoint probe (OpenAI-compatible HTTP APIs).
 *  Used by Pi provider settings today; reusable by any agent's custom provider config. */
export interface ProviderConnectionProbe {
  baseUrl: string;
  apiKey?: string;
  authHeader?: boolean;
  /** Wire protocol, e.g. "openai-completions" / "openai-responses". */
  api?: string;
  /** A concrete model id enables real protocol verification. */
  model?: string;
}

type ProbeResult = { ok: boolean; detail: string; compatSuggestion?: Record<string, unknown> };

/** Minimal real request per wire protocol; returns a failure result, or undefined on success. */
const PROTOCOL_PROBE: Record<string, (baseUrl: string, headers: Record<string, string>, model: string) => Promise<ProbeResult | undefined>> = {
  "openai-completions": async (baseUrl, headers, model) => {
    const post = (messages: unknown[]) => fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      // Some reasoning-model gateways reject max_tokens <= 2.
      body: JSON.stringify({ model, messages, max_tokens: 16 }),
      signal: AbortSignal.timeout(30_000),
    });
    // Pi sends the system prompt as a `developer` role message; probe that first.
    const response = await post([{ role: "developer", content: "ping" }]);
    if (response.ok) return { ok: true, detail: `连接成功，模型 ${model} 的 Chat Completions API 可用` };
    const body = await response.text().catch(() => "");
    if (/developer/.test(body) && /unknown variant|unsupported|not supported|invalid/i.test(body)) {
      const retry = await post([{ role: "system", content: "ping" }]);
      if (retry.ok) {
        return {
          ok: true,
          detail: `连接成功，但端点不支持 developer 角色；已建议写入 compat.supportsDeveloperRole=false`,
          compatSuggestion: { supportsDeveloperRole: false },
        };
      }
      const retryBody = await retry.text().catch(() => "");
      return { ok: false, detail: `Chat Completions API 不可用(HTTP ${retry.status}): ${retryBody.slice(0, 200) || "无错误详情"}` };
    }
    return { ok: false, detail: `Chat Completions API 不可用(HTTP ${response.status}): ${body.slice(0, 200) || "无错误详情"}` };
  },
  "openai-responses": async (baseUrl, headers, model) => {
    const response = await fetch(`${baseUrl}/responses`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ model, input: "ping", max_output_tokens: 16 }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return { ok: true, detail: `连接成功，模型 ${model} 的 Responses API 可用` };
    const body = await response.text().catch(() => "");
    return { ok: false, detail: `Responses API 不可用(HTTP ${response.status}): ${body.slice(0, 200) || "无错误详情"}` };
  },
  "anthropic-messages": async (baseUrl, headers, model) => {
    const response = await fetch(`${baseUrl}/messages`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.ok) return { ok: true, detail: `连接成功，模型 ${model} 的 Messages API 可用` };
    const body = await response.text().catch(() => "");
    return { ok: false, detail: `Messages API 不可用(HTTP ${response.status}): ${body.slice(0, 200) || "无错误详情"}` };
  },
};

export async function testProviderConnection(provider: ProviderConnectionProbe): Promise<{ ok: boolean; detail: string; compatSuggestion?: Record<string, unknown> }> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {};
  if (provider.apiKey) {
    if (provider.authHeader) headers["authorization"] = `Bearer ${provider.apiKey}`;
    else headers["x-api-key"] = provider.apiKey;
  }
  try {
    const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) {
      const hint = response.status === 401 || response.status === 403 ? "API key 无效或无权限" : `HTTP ${response.status}`;
      return { ok: false, detail: hint };
    }
  } catch (error) {
    return { ok: false, detail: networkHint(error) };
  }

  // /models only proves reachability; verify the selected wire protocol with a real call.
  if (provider.model) {
    const probe = PROTOCOL_PROBE[provider.api ?? "openai-completions"];
    if (probe) {
      try {
        const result = await probe(baseUrl, headers, provider.model);
        if (result) return result;
      } catch (error) {
        return { ok: false, detail: networkHint(error) };
      }
    }
  }

  const protocol = provider.api ?? "openai-completions";
  return { ok: true, detail: "连接成功(HTTP 200)" + (PROTOCOL_PROBE[protocol] && !provider.model ? "，但未配置模型，协议未验证" : "") };
}

function networkHint(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("ENOTFOUND")) return "域名无法解析,检查 baseUrl";
  if (message.includes("TimeoutError") || message.includes("timed out")) return "连接超时";
  return message;
}
