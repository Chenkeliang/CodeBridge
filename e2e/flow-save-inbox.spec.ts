import { expect, type Page, test } from "@playwright/test";

type PendingRequest = ReturnType<typeof pendingRequest>;

const candidate = {
  flow_id: "flow_candidate_a",
  name: "Pi 权益核对",
  description: "从全局待生成请求创建",
  kind: "runbook",
  status: "candidate",
  source: "agent_generated",
  definition_revision: "sha256:candidate",
  plan_ir_hash: "sha256:plan",
  inputs: [],
  steps: [],
  review_status: "pending",
  git_revision: null,
  validation_issues: [],
  lineage_root_flow_id: "flow_candidate_a",
  parent_flow_id: null,
  provenance: {
    source_run_id: "run_source_a",
    source_session_id: "sess_a",
    source_flow_id: "flow_ephemeral",
    source_definition_revision: "sha256:source",
    source_request_id: "fsr_a",
  },
  publication_sequence: 0,
  created_at: "2026-08-26T04:00:00.000Z",
  updated_at: "2026-08-26T04:00:01.000Z",
};

const foreignCandidate = {
  ...candidate,
  flow_id: "flow_channel_package",
  name: "channel-package-build-compare",
  definition_revision: "sha256:foreign",
  lineage_root_flow_id: "flow_channel_package",
  provenance: {
    ...candidate.provenance,
    source_run_id: "run_source_b",
    source_session_id: "sess_b",
    source_flow_id: "flow_ephemeral_b",
    source_definition_revision: "sha256:source_b",
    source_request_id: "fsr_b",
  },
  updated_at: "2026-08-26T05:00:00.000Z",
};

function agent(agentId: "pi" | "codex", displayName: string) {
  return {
    agent_id: agentId,
    display_name: displayName,
    adapter: agentId === "pi" ? "sdk" : "acp",
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
  };
}

function session(sessionId: string, agentId: "pi" | "codex", title: string) {
  return {
    session_id: sessionId,
    agent_id: agentId,
    provider_session_id: null,
    task_record_id: `work_${sessionId}`,
    flow_id: null,
    flow_definition_revision: null,
    model: null,
    effort: null,
    config_overrides: {},
    permission_mode: null,
    cwd: `/workspace/${sessionId}`,
    additional_directories: [],
    title,
    status: "idle",
    pinned_at: null,
    archived_at: null,
    created_at: "2026-08-26T03:00:00.000Z",
    updated_at: "2026-08-26T04:00:00.000Z",
  };
}

function pendingRequest(
  requestId: string,
  sessionId: string,
  agentId: string,
  title: string,
) {
  return {
    request_id: requestId,
    session_id: sessionId,
    agent_id: agentId,
    session_title: title,
    request_turn_id: `turn_request_${requestId}`,
    request_run_id: `run_request_${requestId}`,
    source_turn_id: `turn_source_${requestId}`,
    source_run_id: `run_source_${requestId}`,
    source_title: `来源任务 ${requestId}`,
    source: "agent_intent" as const,
    user_message: `请保存 ${requestId}`,
    intent_summary: `沉淀 ${requestId} 的稳定步骤`,
    name_hint: `待生成 ${requestId}`,
    source_imported: false,
    created_at: "2026-08-26T04:00:00.000Z",
    event_sequence: requestId === "fsr_a" ? 41 : 42,
  };
}

function timelineBlock(request: PendingRequest, status: "pending" | "completed" | "dismissed" = "pending") {
  return {
    block_id: `flow_save:${request.request_id}`,
    block_index: 2,
    kind: "flow_save_request",
    status,
    metadata: {
      ...request,
      ...(status === "completed" ? {
        flow_id: candidate.flow_id,
        definition_revision: candidate.definition_revision,
      } : {}),
    },
    segments: [],
    next_segment_cursor: null,
  };
}

function reviewContext() {
  return {
    flow: candidate,
    base: null,
    provenance: candidate.provenance,
    evidence: [],
    history: [],
    diff: {
      name_changed: false,
      description_changed: false,
      inputs: { added: [], removed: [], changed: [] },
      steps: { added: [], removed: [], changed: [], reordered: false },
    },
  };
}

async function installFixture(page: Page, options: {
  pending?: PendingRequest[];
  initialFlows?: Array<typeof candidate>;
  confirmUnknownOnce?: boolean;
  confirmUnavailableOnce?: boolean;
  dismissUnknownOnce?: boolean;
  delaySecondInbox?: boolean;
  delayConfirmFailure?: boolean;
  delayConfirmSuccess?: boolean;
} = {}) {
  const sessionA = session("sess_a", "pi", "Pi Session A");
  const sessionB = session("sess_b", "codex", "Codex Session B");
  const state = {
    pending: [...(options.pending ?? [pendingRequest("fsr_a", "sess_a", "pi", sessionA.title)])],
    flows: [...(options.initialFlows ?? [])],
    terminals: new Map<string, "completed" | "dismissed">(),
  };
  const confirmCalls: Array<{ requestId: string; key: string }> = [];
  const dismissCalls: Array<{ requestId: string; key: string }> = [];
  let inboxCalls = 0;
  let confirmAttempts = 0;
  let dismissAttempts = 0;
  let releaseSecondInbox!: () => void;
  let markSecondInboxStarted!: () => void;
  const secondInboxGate = new Promise<void>((resolve) => { releaseSecondInbox = resolve; });
  const secondInboxStarted = new Promise<void>((resolve) => { markSecondInboxStarted = resolve; });
  let releaseConfirm!: () => void;
  let markConfirmStarted!: () => void;
  const confirmGate = new Promise<void>((resolve) => { releaseConfirm = resolve; });
  const confirmStarted = new Promise<void>((resolve) => { markConfirmStarted = resolve; });

  function snapshot(value: typeof sessionA) {
    const sourceRequests = [...state.pending, ...Array.from(state.terminals, ([requestId]) =>
      pendingRequest(requestId, "sess_a", "pi", sessionA.title)
    )].filter((request) => request.session_id === value.session_id);
    const blocks = [{
      block_id: `user:${value.session_id}`,
      block_index: 0,
      kind: "user_message",
      status: "completed",
      metadata: {},
      segments: [{
        segment_id: `user:${value.session_id}:0`,
        segment_index: 0,
        content: `任务 ${value.title}`,
        byte_length: 12,
        sealed: true,
      }],
      next_segment_cursor: null,
    }, ...sourceRequests.map((request) => timelineBlock(
      request,
      state.terminals.get(request.request_id) ?? "pending",
    ))];
    return {
      session: value,
      runtime: {
        active_run: null,
        queue_state: "ready",
        queue_pause_reason: null,
        queue: { turns: [], total: 0, next_cursor: null },
        version: 1,
        last_event_sequence: 50,
      },
      timeline: {
        turns: [{
          timeline_index: 1,
          turn_id: `turn_${value.session_id}`,
          run_id: `run_${value.session_id}`,
          status: "succeeded",
          blocks,
        }],
        previous_cursor: null,
        truncated_block_ids: [],
      },
      commands: [],
      options: [],
      runs: [],
    };
  }

  await page.addInitScript(() => {
    (globalThis as typeof globalThis & { process?: { env: Record<string, string> } }).process = { env: {} };
    localStorage.setItem("codebridge:last-session:codex", "sess_b");
  });
  await page.route("**/workbench/config.json", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ token: "test" }),
  }));
  await page.route("**/v1/agents", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      agents: [agent("pi", "Pi"), agent("codex", "Codex")],
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
    body: JSON.stringify({ sessions: [sessionA, sessionB] }),
  }));
  await page.route(/\/v1\/flows(?:\?.*)?$/, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ flows: state.flows }),
  }));
  await page.route("**/v1/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ capabilities: [] }),
  }));
  await page.route(/\/v1\/flows\/([^/]+)\/review-context$/, (route) => {
    const flowId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const flow = state.flows.find((entry) => entry.flow_id === flowId);
    if (!flow) {
      return route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "flow_not_found" }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ...reviewContext(),
        flow,
        provenance: flow.provenance,
      }),
    });
  });
  await page.route("**/v1/flow-save-requests?*", async (route) => {
    inboxCalls += 1;
    const captured = [...state.pending];
    if (options.delaySecondInbox && inboxCalls === 2) {
      markSecondInboxStarted();
      await secondInboxGate;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ requests: captured, next_cursor: null }),
    }).catch(() => undefined);
  });
  await page.route(/\/v1\/flow-save-requests\/([^/]+)\/confirm$/, async (route) => {
    const requestId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const key = route.request().headers()["idempotency-key"] ?? "";
    confirmCalls.push({ requestId, key });
    confirmAttempts += 1;
    if ((options.delayConfirmFailure || options.delayConfirmSuccess) && confirmAttempts === 1) {
      markConfirmStarted();
      await confirmGate;
      if (options.delayConfirmFailure) {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "delayed_confirm_failed" }),
        });
        return;
      }
    }
    if (options.confirmUnavailableOnce && confirmAttempts === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "flow_catalog_unavailable" }),
      });
      return;
    }
    if (options.confirmUnknownOnce && confirmAttempts === 1) {
      await route.abort("failed");
      return;
    }
    const request = state.pending.find((entry) => entry.request_id === requestId)!;
    state.pending = state.pending.filter((entry) => entry.request_id !== requestId);
    state.terminals.set(requestId, "completed");
    if (!state.flows.some((flow) => flow.flow_id === candidate.flow_id)) state.flows.push(candidate);
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ state: "completed", request, flow: candidate }),
    });
  });
  await page.route(/\/v1\/flow-save-requests\/([^/]+)\/dismiss$/, async (route) => {
    const requestId = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const key = route.request().headers()["idempotency-key"] ?? "";
    dismissCalls.push({ requestId, key });
    dismissAttempts += 1;
    if (options.dismissUnknownOnce && dismissAttempts === 1) {
      await route.abort("failed");
      return;
    }
    const request = state.pending.find((entry) => entry.request_id === requestId)!;
    state.pending = state.pending.filter((entry) => entry.request_id !== requestId);
    state.terminals.set(requestId, "dismissed");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "dismissed", request }),
    });
  });

  for (const value of [sessionA, sessionB]) {
    await page.route(new RegExp(`/v1/sessions/${value.session_id}$`), (route) => route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(snapshot(value)),
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

  return {
    state,
    confirmCalls,
    dismissCalls,
    secondInboxStarted,
    releaseSecondInbox,
    confirmStarted,
    releaseConfirm,
  };
}

async function openPending(page: Page, requestId = "fsr_a") {
  await page.getByRole("button", { name: /^Flows/ }).click();
  await page.locator(`[data-flow-save-inbox-request="${requestId}"]`).click();
  await expect(page.locator(`[data-flow-save-inbox-detail="${requestId}"]`)).toBeVisible();
}

test("Flows opens the newest Candidate for the active Session and restores that Session", async ({ page }) => {
  await installFixture(page, { initialFlows: [foreignCandidate, candidate] });
  await page.goto("/workbench/");
  await page.locator('button[aria-label="Pi"]').click();
  await page.getByText("Pi Session A", { exact: true }).click();
  await expect(page.getByRole("region", { name: "Session conversation" })).toBeVisible();

  await page.getByRole("button", { name: /^Flows/ }).click();
  const management = page.getByRole("region", { name: "Flow 管理" });
  await expect(management).toBeVisible();
  await expect(management.getByText(candidate.name, { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("region", { name: "Session conversation" })).toHaveCount(0);
  const foreignButton = page.getByRole("button", { name: `${foreignCandidate.name} runbook` });
  await expect(foreignButton).not.toHaveClass(/border-line/);
  await foreignButton.click();
  await expect(management.getByText(foreignCandidate.name, { exact: true }).first()).toBeVisible();

  await page.locator('button[aria-label="Pi"]').click();
  await expect(page.getByRole("region", { name: "Session conversation" })).toBeVisible();
  await expect(page.getByText("Pi Session A", { exact: true }).first()).toBeVisible();

  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByRole("region", { name: "Flow 管理" }).getByText(candidate.name, { exact: true }).first()).toBeVisible();
});

test("re-entering Flows clears a stale unrelated selection when the Session has no Candidate", async ({ page }) => {
  await installFixture(page, { initialFlows: [foreignCandidate] });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByRole("region", { name: "Flow 管理" }).getByText(foreignCandidate.name, { exact: true }).first()).toBeVisible();

  await page.locator('button[aria-label="Pi"]').click();
  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByRole("region", { name: "Flow 选择" })).toContainText("从左侧选择 Flow 或待生成请求");
  await expect(page.getByRole("region", { name: "Session conversation" })).toHaveCount(0);
});

test("discovers Pi A globally while Codex B stays selected, then locates the exact source card", async ({ page }) => {
  await installFixture(page);
  await page.goto("/workbench/");
  await expect(page.getByText("Codex Session B", { exact: true }).first()).toBeVisible();

  await openPending(page);
  await expect(page.getByText("待生成 · 1", { exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Session conversation" })).toHaveCount(0);
  await page.locator('button[aria-label="Codex"]').click();
  await expect(page.getByText("Codex Session B", { exact: true }).first()).toBeVisible();

  await page.reload();
  await openPending(page);
  await page.locator('button[aria-label="Codex"]').click();
  await expect(page.getByText("Codex Session B", { exact: true }).first()).toBeVisible();
  await openPending(page);

  await page.getByRole("button", { name: "定位来源 Session" }).click();
  const sourceCard = page.locator('[data-flow-save-request-id="fsr_a"]');
  await expect(page.getByText("Pi Session A", { exact: true }).first()).toBeVisible();
  await expect(sourceCard).toBeVisible();
  await expect(sourceCard).toBeFocused();
});

test("confirm creates one Candidate, removes pending, opens it, and survives reload", async ({ page }) => {
  const fixture = await installFixture(page);
  await page.goto("/workbench/");
  await openPending(page);

  await page.getByRole("button", { name: "生成 Candidate" }).click();

  await expect.poll(() => fixture.confirmCalls.length).toBe(1);
  await expect(page.getByText(candidate.name, { exact: true }).first()).toBeVisible();
  await expect(page.locator('[data-flow-save-inbox-request="fsr_a"]')).toHaveCount(0);
  expect(fixture.state.flows).toHaveLength(1);

  await page.reload();
  await page.getByRole("button", { name: /^Flows/ }).click();
  await expect(page.getByText(candidate.name, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("待生成 · 1", { exact: true })).toHaveCount(0);
});

test("dismiss unknown retry keeps its key, cannot confirm, and selects the next request", async ({ page }) => {
  const next = pendingRequest("fsr_b", "sess_b", "codex", "Codex Session B");
  const fixture = await installFixture(page, {
    pending: [pendingRequest("fsr_a", "sess_a", "pi", "Pi Session A"), next],
    dismissUnknownOnce: true,
  });
  await page.goto("/workbench/");
  await openPending(page);

  await page.getByRole("button", { name: "忽略" }).click();
  await expect(page.getByRole("button", { name: "重试忽略" })).toBeVisible();
  await expect(page.getByRole("button", { name: /生成 Candidate/ })).toHaveCount(0);
  await page.getByRole("button", { name: "重试忽略" }).click();

  await expect(page.locator('[data-flow-save-inbox-detail="fsr_b"]')).toBeVisible();
  expect(fixture.dismissCalls).toHaveLength(2);
  expect(fixture.dismissCalls[0]!.key).toBe(fixture.dismissCalls[1]!.key);
});

test("confirm 503 retains pending and reuses only the confirm key", async ({ page }) => {
  const fixture = await installFixture(page, { confirmUnavailableOnce: true });
  await page.goto("/workbench/");
  await openPending(page);

  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.getByRole("button", { name: "重试生成" })).toBeVisible();
  await expect(page.locator('[data-flow-save-inbox-request="fsr_a"]')).toBeVisible();
  await expect(page.getByRole("button", { name: "忽略" })).toHaveCount(0);
  await page.getByRole("button", { name: "重试生成" }).click();

  await expect.poll(() => fixture.confirmCalls.length).toBe(2);
  expect(fixture.confirmCalls[0]!.key).toBe(fixture.confirmCalls[1]!.key);
});

test("confirm unknown retries only confirm with the same key", async ({ page }) => {
  const fixture = await installFixture(page, { confirmUnknownOnce: true });
  await page.goto("/workbench/");
  await openPending(page);

  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.getByRole("button", { name: "重试生成" })).toBeVisible();
  await expect(page.getByRole("button", { name: "忽略" })).toHaveCount(0);
  await page.getByRole("button", { name: "重试生成" }).click();

  await expect.poll(() => fixture.confirmCalls.length).toBe(2);
  expect(fixture.confirmCalls[0]!.key).toBe(fixture.confirmCalls[1]!.key);
  await expect(page.getByText(candidate.name, { exact: true }).first()).toBeVisible();
});

test("an aborted late poll cannot resurrect a confirmed request", async ({ page }) => {
  const fixture = await installFixture(page, { delaySecondInbox: true });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: /^Flows/ }).click();
  await fixture.secondInboxStarted;
  await page.locator('[data-flow-save-inbox-request="fsr_a"]').click();
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.getByText(candidate.name, { exact: true }).first()).toBeVisible();

  fixture.releaseSecondInbox();
  await page.waitForTimeout(100);
  await expect(page.locator('[data-flow-save-inbox-request="fsr_a"]')).toHaveCount(0);
});

test("a delayed failure from request A cannot notify or replace newly selected detail B", async ({ page }) => {
  const second = pendingRequest("fsr_b", "sess_b", "codex", "Codex Session B");
  const fixture = await installFixture(page, {
    pending: [pendingRequest("fsr_a", "sess_a", "pi", "Pi Session A"), second],
    delayConfirmFailure: true,
  });
  await page.goto("/workbench/");
  await openPending(page);
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await fixture.confirmStarted;
  await page.locator('[data-flow-save-inbox-request="fsr_b"]').click();
  fixture.releaseConfirm();

  await expect(page.locator('[data-flow-save-inbox-detail="fsr_b"]')).toBeVisible();
  await expect(page.getByText("delayed_confirm_failed")).toHaveCount(0);
});

test("a delayed success from request A cannot replace newly selected detail B", async ({ page }) => {
  const second = pendingRequest("fsr_b", "sess_b", "codex", "Codex Session B");
  const fixture = await installFixture(page, {
    pending: [pendingRequest("fsr_a", "sess_a", "pi", "Pi Session A"), second],
    delayConfirmSuccess: true,
  });
  await page.goto("/workbench/");
  await openPending(page);
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await fixture.confirmStarted;
  await page.locator('[data-flow-save-inbox-request="fsr_b"]').click();
  fixture.releaseConfirm();

  await expect.poll(() => fixture.confirmCalls.length).toBe(1);
  await expect(page.locator('[data-flow-save-inbox-detail="fsr_b"]')).toBeVisible();
});

test("100 hostile pending requests stay contained from 320 through 1536 pixels", async ({ page }) => {
  const uuid = "83944f05-2d18-4935-8296-773caa8165fc";
  const hostilePath = `/Users/keliang/${"unbroken-path-segment/".repeat(120)}`;
  const pending = Array.from({ length: 100 }, (_, index) => ({
    ...pendingRequest(
      `fsr_bulk_${index}_${uuid}`,
      index % 2 === 0 ? "sess_a" : "sess_b",
      index === 1 ? "missing-agent" : index % 2 === 0 ? "pi" : "codex",
      index % 2 === 0 ? "Pi Session A" : "Codex Session B",
    ),
    name_hint: `待生成_${uuid}_${"LONG".repeat(180)}`,
    source_title: `来源 ${hostilePath}`,
    user_message: `请保存 ${uuid} ${hostilePath}`,
    intent_summary: `复用摘要_${"without-break".repeat(240)}`,
    source_imported: index === 0,
    event_sequence: 100 + index,
  }));
  await installFixture(page, { pending });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: /^Flows/ }).click();

  await expect(page.locator("[data-flow-save-badge]")).toHaveText("99+");
  await expect(page.locator("[data-flow-save-inbox-request]")).toHaveCount(100);
  await page.locator("[data-flow-save-inbox-request]").first().click();
  await expect(page.getByText("来源为导入历史，请确认其步骤仍然适用。")).toBeVisible();

  for (const width of [320, 768, 1280, 1536]) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const item = document.querySelector<HTMLElement>("[data-flow-save-inbox-request]");
      const list = item?.parentElement?.parentElement;
      const detail = document.querySelector<HTMLElement>("[data-flow-save-inbox-detail]");
      return {
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        list: list ? list.scrollWidth - list.clientWidth : -1,
        listVisible: Boolean(list?.getClientRects().length),
        listScrolls: list ? list.scrollHeight > list.clientHeight : false,
        detail: detail ? detail.scrollWidth - detail.clientWidth : -1,
      };
    });
    expect(metrics.document, `document overflow at ${width}`).toBeLessThanOrEqual(0);
    expect(metrics.list, `pending list overflow at ${width}`).toBeLessThanOrEqual(0);
    if (width < 768) {
      expect(metrics.listVisible, `responsive pending list visibility at ${width}`).toBe(false);
    } else {
      expect(metrics.listVisible, `responsive pending list visibility at ${width}`).toBe(true);
      expect(metrics.listScrolls, `pending list must scroll internally at ${width}`).toBe(true);
    }
    expect(metrics.detail, `pending detail overflow at ${width}`).toBeLessThanOrEqual(0);
    const confirm = page.getByRole("button", { name: "生成 Candidate" });
    const dismiss = page.getByRole("button", { name: "忽略" });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeInViewport();
    await dismiss.scrollIntoViewIfNeeded();
    await expect(dismiss).toBeInViewport();
  }

  await page.locator("[data-flow-save-inbox-request]").nth(1).click();
  await expect(page.getByText("Agent · missing-agent")).toBeVisible();
});
