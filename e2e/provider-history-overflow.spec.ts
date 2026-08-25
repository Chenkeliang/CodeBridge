import { expect, type Page, test } from "@playwright/test";

type MockSession = ReturnType<typeof session>;

function session(id: string, title: string): {
  session_id: string;
  agent_id: string;
  provider_session_id: string;
  task_record_id: null;
  flow_id: null;
  flow_definition_revision: null;
  model: null;
  effort: null;
  config_overrides: Record<string, never>;
  permission_mode: null;
  cwd: string;
  additional_directories: never[];
  title: string;
  status: "idle";
  pinned_at: null;
  archived_at: null;
  created_at: string;
  updated_at: string;
} {
  return {
    session_id: id,
    agent_id: "codex",
    provider_session_id: `provider-${id}`,
    task_record_id: null,
    flow_id: null,
    flow_definition_revision: null,
    model: null,
    effort: null,
    config_overrides: {},
    permission_mode: null,
    cwd: "/workspace",
    additional_directories: [],
    title,
    status: "idle",
    pinned_at: null,
    archived_at: null,
    created_at: "2026-08-25T00:00:00.000Z",
    updated_at: "2026-08-25T00:00:00.000Z",
  };
}

function snapshot(value: MockSession, imported = false) {
  const turns = imported ? [{
    timeline_index: 1,
    turn_id: `turn-${value.session_id}`,
    run_id: `run-${value.session_id}`,
    status: "completed",
    blocks: [{
      block_id: `user-${value.session_id}`,
      block_index: 0,
      kind: "user_message",
      status: "completed",
      metadata: {},
      segments: [{
        segment_id: `segment-${value.session_id}`,
        segment_index: 0,
        content: "已恢复的历史消息",
        byte_length: 24,
        sealed: true,
      }],
      next_segment_cursor: null,
    }],
  }] : [];
  return {
    session: value,
    runtime: {
      active_run: null,
      queue_state: "ready",
      queue_pause_reason: null,
      queue: { turns: [], total: 0, next_cursor: null },
      version: 1,
      last_event_sequence: imported ? 2 : 0,
    },
    timeline: { turns, previous_cursor: null, truncated_block_ids: [] },
    commands: [],
    events: [],
    options: [],
    runs: [],
  };
}

function hostileSnapshot(value: MockSession) {
  const hostile = [
    "中".repeat(2_500),
    "english".repeat(1_250),
    "x".repeat(10_000),
    "https://example.com/" + "path/".repeat(1_000),
    JSON.stringify({ markdown: "**bold**", code: "`const value = true`" }).repeat(250),
  ].join("\n");
  const queueTurns = Array.from({ length: 100 }, (_, index) => ({
    turn_id: `queued-${index}`,
    queue_position: index + 1,
    status: "queued",
    version: 1,
    message: { text: `${index + 1} ${hostile}`, attachment_ids: [] },
    created_at: "2026-08-25T00:00:00.000Z",
  }));
  return {
    ...snapshot(value),
    runtime: {
      active_run: { run_id: "run-active", turn_id: "turn-active", status: "running", started_at: "2026-08-25T00:00:00.000Z" },
      queue_state: "ready",
      queue_pause_reason: null,
      queue: { turns: queueTurns, total: queueTurns.length, next_cursor: null },
      version: 2,
      last_event_sequence: 2,
    },
    timeline: {
      turns: [{
        timeline_index: 1,
        turn_id: "turn-hostile",
        run_id: "run-hostile",
        status: "completed",
        blocks: [{
          block_id: "user-hostile",
          block_index: 0,
          kind: "user_message",
          status: "completed",
          metadata: {},
          segments: [{
            segment_id: "segment-hostile",
            segment_index: 0,
            content: hostile,
            byte_length: hostile.length,
            sealed: true,
          }],
          next_segment_cursor: null,
        }],
      }],
      previous_cursor: null,
      truncated_block_ids: [],
    },
  };
}

async function installWorkbenchRoutes(page: Page, sessions: MockSession[], isImported: (id: string) => boolean) {
  await page.addInitScript((sessionId) => {
    (globalThis as typeof globalThis & { process?: { env: Record<string, string> } }).process = { env: {} };
    localStorage.setItem("codebridge:last-session:codex", sessionId);
  }, sessions[0]!.session_id);
  await page.route("**/workbench/config.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ token: "test" }),
  }));
  await page.route("**/v1/agents", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      agents: [{
        agent_id: "codex",
        display_name: "Codex",
        adapter: "sdk",
        status: "healthy",
        capabilities: ["session"],
        models: [],
        session_features: ["resume"],
        setup: {
          installation: "installed",
          configuration: "configured",
          runtime: "healthy",
          version: "test",
          can_select_default: true,
          can_create_session: true,
        },
      }],
      default_agent_id: "codex",
      effective_default_agent_id: "codex",
    }),
  }));
  await page.route("**/v1/sessions/import", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions: [], provider_errors: [] }),
  }));
  await page.route("**/v1/sessions?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ sessions, archived_sessions: [] }),
  }));
  await page.route("**/v1/flows?*", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ flows: [] }),
  }));
  await page.route("**/v1/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ capabilities: [] }),
  }));

  for (const value of sessions) {
    await page.route(`**/v1/sessions/${value.session_id}`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot(value, isImported(value.session_id))),
    }));
    await page.route(`**/v1/sessions/${value.session_id}/config-options`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ options: [] }),
    }));
    await page.route(`**/v1/sessions/${value.session_id}/commands`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ commands: [] }),
    }));
    await page.route(`**/v1/sessions/${value.session_id}/flow-proposals`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ proposals: [] }),
    }));
    await page.route(`**/v1/sessions/${value.session_id}/flow-recommendations`, (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ recommendations: [] }),
    }));
    await page.route(`**/v1/sessions/${value.session_id}/events*`, (route) => route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ": keep-alive\n\n",
    }));
  }
}

test("history Preview ignores a late response from the previous Session", async ({ page }) => {
  const sessionA = session("sess_a", "Session A");
  const sessionB = session("sess_b", "Session B");
  let previewAStarted = false;
  let releasePreviewA: (() => void) | undefined;
  const previewAGate = new Promise<void>((resolve) => { releasePreviewA = resolve; });

  await installWorkbenchRoutes(page, [sessionA, sessionB], () => false);
  await page.route("**/v1/sessions/sess_a/provider-history/preview", async (route) => {
    previewAStarted = true;
    await previewAGate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerSessionId: sessionA.provider_session_id,
        importedPosition: 0,
        providerPosition: 401,
        importableEvents: 401,
        nextDigest: "sha256:a",
      }),
    });
  });
  await page.route("**/v1/sessions/sess_b/provider-history/preview", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      providerSessionId: sessionB.provider_session_id,
      importedPosition: 0,
      providerPosition: 0,
      importableEvents: 0,
      nextDigest: "sha256:b",
    }),
  }));

  await page.goto("/workbench/");
  await expect.poll(() => previewAStarted).toBe(true);
  await page.getByTitle("Session B").click();
  await expect(page.getByText("Provider 历史已同步")).toBeVisible();
  releasePreviewA?.();
  await expect(page.getByText("发现 401 条可导入历史记录")).toHaveCount(0);
  await expect(page.getByText("Provider 历史已同步")).toBeVisible();
});

test("history Import retries an unknown result with the same caller key", async ({ page }) => {
  const value = session("sess_a", "Session A");
  let imported = false;
  const keys: string[] = [];

  await installWorkbenchRoutes(page, [value], () => imported);
  await page.route("**/v1/sessions/sess_a/provider-history/preview", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      providerSessionId: value.provider_session_id,
      importedPosition: 0,
      providerPosition: 2,
      importableEvents: 2,
      nextDigest: "sha256:available",
    }),
  }));
  await page.route("**/v1/sessions/sess_a/provider-history/import", async (route) => {
    keys.push(route.request().headers()["idempotency-key"] ?? "");
    if (keys.length === 1) {
      await route.abort("failed");
      return;
    }
    imported = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ importedEvents: 2, importedTurns: 1, lastEventSequence: 2 }),
    });
  });

  await page.goto("/workbench/");
  await page.getByRole("button", { name: "导入历史" }).click();
  await expect(page.getByRole("button", { name: "重试导入" })).toBeVisible();
  await page.getByRole("button", { name: "重试导入" }).click();
  await expect(page.getByText("已导入 2 条历史记录")).toBeVisible();
  await expect(page.getByText("已恢复的历史消息")).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test("history 401 Preview stays read-only, single-confirms, and survives refresh", async ({ page }) => {
  const value = session("sess_a", "Session A");
  let imported = false;
  let importCalls = 0;
  let releaseImport: (() => void) | undefined;
  const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });

  await installWorkbenchRoutes(page, [value], () => imported);
  await page.route("**/v1/sessions/sess_a/provider-history/preview", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      providerSessionId: value.provider_session_id,
      importedPosition: imported ? 401 : 0,
      providerPosition: 401,
      importableEvents: imported ? 0 : 401,
      nextDigest: "sha256:401",
    }),
  }));
  await page.route("**/v1/sessions/sess_a/provider-history/import", async (route) => {
    importCalls += 1;
    await importGate;
    imported = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ importedEvents: 401, importedTurns: 1, lastEventSequence: 2 }),
    });
  });

  await page.goto("/workbench/");
  await expect(page.getByText("发现 401 条可导入历史记录")).toBeVisible();
  expect(importCalls).toBe(0);
  await page.getByRole("button", { name: "导入历史" }).evaluate((button) => {
    (button as HTMLButtonElement).click();
    (button as HTMLButtonElement).click();
  });
  await expect.poll(() => importCalls).toBe(1);
  releaseImport?.();
  await expect(page.getByText("已导入 401 条历史记录")).toBeVisible();
  await expect(page.getByText("已恢复的历史消息")).toBeVisible();

  await page.reload();
  await expect(page.getByText("已恢复的历史消息")).toBeVisible();
  await expect(page.locator("[data-provider-history]")).toHaveCount(0);
});

test("history Preview failure retries only the read path", async ({ page }) => {
  const value = session("sess_a", "Session A");
  let previewCalls = 0;
  await installWorkbenchRoutes(page, [value], () => false);
  await page.route("**/v1/sessions/sess_a/provider-history/preview", async (route) => {
    previewCalls += 1;
    if (previewCalls === 1) {
      await route.fulfill({
        status: 502,
        contentType: "application/json",
        body: JSON.stringify({ error: "provider_history_unavailable" }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerSessionId: value.provider_session_id,
        importedPosition: 0,
        providerPosition: 0,
        importableEvents: 0,
        nextDigest: "sha256:empty",
      }),
    });
  });

  await page.goto("/workbench/");
  await expect(page.getByText("暂时无法读取 Provider 历史。")).toBeVisible();
  await page.getByRole("button", { name: "重试检查" }).click();
  await expect(page.getByText("Provider 历史已同步")).toBeVisible();
  expect(previewCalls).toBe(2);
});

test("history Prefix Drift blocks Import without unsafe retry", async ({ page }) => {
  const value = session("sess_a", "Session A");
  await installWorkbenchRoutes(page, [value], () => false);
  await page.route("**/v1/sessions/sess_a/provider-history/preview", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      providerSessionId: value.provider_session_id,
      importedPosition: 1,
      providerPosition: 2,
      importableEvents: 1,
      nextDigest: "sha256:changed",
    }),
  }));
  await page.route("**/v1/sessions/sess_a/provider-history/import", (route) => route.fulfill({
    status: 409,
    contentType: "application/json",
    body: JSON.stringify({ error: "provider_history_prefix_changed" }),
  }));

  await page.goto("/workbench/");
  await page.getByRole("button", { name: "导入历史" }).click();
  await expect(page.getByText("Provider 历史前缀已变化，无法安全自动合并。")).toBeVisible();
  await expect(page.getByRole("button", { name: /重试/ })).toHaveCount(0);
});

test("history Preview 0 leaves an existing Timeline unobstructed", async ({ page }) => {
  const value = session("sess_a", "Session A");
  await installWorkbenchRoutes(page, [value], () => true);
  await page.route("**/v1/sessions/sess_a/provider-history/preview", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      providerSessionId: value.provider_session_id,
      importedPosition: 2,
      providerPosition: 2,
      importableEvents: 0,
      nextDigest: "sha256:same",
    }),
  }));

  await page.goto("/workbench/");
  await expect(page.getByText("已恢复的历史消息")).toBeVisible();
  await expect(page.locator("[data-provider-history]")).toHaveCount(0);
});

for (const width of [320, 768, 1280, 1536]) {
  test(`overflow contains hostile content at ${width}px`, async ({ page }) => {
    const value = session("sess_hostile", "标题".repeat(5_000));
    await page.setViewportSize({ width, height: 900 });
    await installWorkbenchRoutes(page, [value], () => false);
    await page.route("**/v1/sessions/sess_hostile", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(hostileSnapshot(value)),
    }));
    await page.route("**/v1/sessions/sess_hostile/provider-history/preview", (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        providerSessionId: value.provider_session_id,
        importedPosition: 2,
        providerPosition: 2,
        importableEvents: 0,
        nextDigest: "sha256:same",
      }),
    }));

    await page.goto("/workbench/");
    const metrics = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }));
    expect(metrics.scrollWidth).toBe(metrics.clientWidth);
    await expect(page.getByRole("button", { name: "Session 操作" })).toBeInViewport();
    await expect(page.getByRole("button", { name: /取消排队消息/ }).first()).toBeInViewport();
    await expect(page.getByRole("textbox", { name: "消息" })).toBeInViewport();
  });
}
