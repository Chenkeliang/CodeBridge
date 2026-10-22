/** Shared by the terminal wizard and Web connection management. These calls never send messages. */
export async function verifyFeishu(fetchImpl: typeof fetch, domain: string, appId: string, appSecret: string): Promise<string | undefined> {
  // Never send the secret over plain HTTP.
  if (!/^https:\/\//.test(domain)) return `feishu.domain 不是 https（${domain}），不发送密钥`;
  try {
    const response = await fetchImpl(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as { code?: number; msg?: string };
    return response.ok && body.code === 0 ? undefined : `${body.msg ?? `HTTP ${response.status}`}（code ${body.code ?? "?"}）`.replaceAll(appSecret, "[REDACTED]");
  } catch (error) {
    return `无法连接 ${domain}：${error instanceof Error ? error.message : String(error)}`.replaceAll(appSecret, "[REDACTED]");
  }
}

export async function telegramCall<T>(fetchImpl: typeof fetch, token: string, method: string): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token)) return { ok: false, error: "格式应为 123456:ABC…" };
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, { redirect: "error", signal: AbortSignal.timeout(10_000) });
    const body = await response.json().catch(() => ({})) as { ok?: boolean; result?: T; description?: string };
    return response.ok && body.ok ? { ok: true, result: body.result as T } : { ok: false, error: (body.description ?? `HTTP ${response.status}`).replaceAll(token, "[REDACTED]") };
  } catch (error) {
    return { ok: false, error: (error instanceof Error ? error.message : String(error)).replaceAll(token, "[REDACTED]") };
  }
}
