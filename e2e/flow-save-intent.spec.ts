import { expect, type Page, test } from "@playwright/test";

type ConfirmMode = "success" | "unknown-once" | "unavailable-once" | "failed";

const candidate = {
  flow_id: "flow_save_candidate",
  name: "公司权益核对",
  description: "从明确保存意图生成",
  kind: "runbook",
  status: "candidate",
  source: "agent_generated",
  definition_revision: "sha256:def",
  plan_ir_hash: "sha256:plan",
  inputs: [],
  steps: [{
    id: "lookup",
    capability: "demo.lookup",
    purpose: "查询权益",
    depends_on: [],
    mode: "read_only",
    approval: "none",
    branches: [],
    retry: null,
    success_when: "result exists",
  }],
  review_status: "pending",
  git_revision: null,
  validation_issues: [],
  lineage_root_flow_id: "flow_save_candidate",
  parent_flow_id: null,
  provenance: {
    source_run_id: "run-a",
    source_session_id: "sess-a",
    source_flow_id: "flow_ephemeral",
    source_definition_revision: "sha256:source",
    source_request_id: "fsr_one",
  },
  publication_sequence: 0,
  created_at: "2026-08-25T00:00:00.000Z",
  updated_at: "2026-08-25T00:00:00.000Z",
};

function session(id: string, title: string) {
  return {
    session_id: id,
    agent_id: "codex",
    provider_session_id: null,
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

function answerTurn(id: string, message: string) {
  return {
    timeline_index: 1,
    turn_id: `turn-${id}`,
    run_id: `run-${id}`,
    status: "succeeded",
    blocks: [
      {
        block_id: `user:${id}`,
        block_index: 0,
        kind: "user_message",
        status: "succeeded",
        metadata: {},
        segments: [{
          segment_id: `user:${id}:0`,
          segment_index: 0,
          content: "请查询公司权益",
          byte_length: 24,
          sealed: true,
        }],
        next_segment_cursor: null,
      },
      {
        block_id: `assistant:${id}`,
        block_index: 1,
        kind: "assistant",
        status: "succeeded",
        metadata: {},
        segments: [{
          segment_id: `assistant:${id}:0`,
          segment_index: 0,
          content: message,
          byte_length: new TextEncoder().encode(message).byteLength,
          sealed: true,
        }],
        next_segment_cursor: null,
      },
    ],
  };
}

function requestBlock(input: {
  status?: "pending" | "completed" | "dismissed" | "failed";
  imported?: boolean;
  summary?: string;
  errorCode?: string;
  requestId?: string;
  sourceRunId?: string;
  sourceTurnId?: string;
  nameHint?: string;
  sessionId?: string;
  eventSequence?: number;
} = {}) {
  const status = input.status ?? "pending";
  const requestId = input.requestId ?? "fsr_one";
  const sourceRunId = input.sourceRunId ?? "run-a";
  const sourceTurnId = input.sourceTurnId ?? "turn-a";
  return {
    block_id: `flow_save:${requestId}`,
    block_index: 2,
    kind: "flow_save_request",
    status,
    metadata: {
      request_id: requestId,
      session_id: input.sessionId ?? "sess-a",
      request_turn_id: sourceTurnId,
      request_run_id: sourceRunId,
      source_turn_id: sourceTurnId,
      source_run_id: sourceRunId,
      source_title: input.summary ?? "查询公司权益并核对交付",
      source: "turn_action",
      user_message: input.summary ?? "查询公司权益并核对交付",
      source_imported: input.imported ?? false,
      event_sequence: input.eventSequence ?? 9,
      ...(status === "completed"
        ? {
            flow_id: candidate.flow_id,
            definition_revision: candidate.definition_revision,
            name_hint: input.nameHint ?? candidate.name,
          }
        : {}),
      ...(input.errorCode ? { error_code: input.errorCode } : {}),
    },
    segments: [],
    next_segment_cursor: null,
  };
}

function requestRecord(imported = false, requestId = "fsr_one", sourceRunId = "run-a") {
  const suffix = sourceRunId.replace("run-", "");
  return {
    request_id: requestId,
    session_id: "sess-a",
    request_turn_id: `turn-${suffix}`,
    request_run_id: sourceRunId,
    source_turn_id: `turn-${suffix}`,
    source_run_id: sourceRunId,
    source: "turn_action",
    user_message: "查询公司权益并核对交付",
    intent_summary: null,
    name_hint: null,
    source_imported: imported,
    created_at: "2026-08-25T00:00:00.000Z",
  };
}

async function installFixture(page: Page, options: {
  confirmMode?: ConfirmMode;
  confirmCommitsThenDisconnectOnce?: boolean;
  delayedConfirm?: { wait: Promise<void> };
  delayedReviewContext?: { wait: Promise<void>; onStarted: () => void; status?: number };
  dismissUnknownOnce?: boolean;
  dismissCommitsThenDisconnectOnce?: boolean;
  terminalDelivery?: "sse" | "hydrate";
  delayedTerminalDelivery?: { wait: Promise<void>; onStarted: () => void };
  imported?: boolean;
  initialBlock?: ReturnType<typeof requestBlock> | null;
  delayedRequest?: { wait: Promise<void> };
  requestUnknownOnce?: boolean;
  unrelatedEventAfterUnknown?: boolean;
  requestCommitsThenDisconnectOnce?: boolean;
  committedRequestDelivery?: "sse" | "hydrate";
  sessions?: ReturnType<typeof session>[];
  concurrentRequests?: boolean;
  twoEligibleTurns?: boolean;
} = {}) {
  const sessions = options.sessions ?? [session("sess-a", "Session A")];
  const turns = new Map(sessions.map((value) => [
    value.session_id,
    [answerTurn(value.session_id.replace("sess-", ""), `已完成 ${value.title}`)],
  ]));
  if (options.initialBlock) turns.get("sess-a")?.[0]?.blocks.push(options.initialBlock);
  if (options.concurrentRequests) {
    turns.get("sess-a")?.[0]?.blocks.push(requestBlock());
    const second = answerTurn("b", "已完成第二个任务");
    second.blocks.push(requestBlock({
      requestId: "fsr_two",
      sourceRunId: "run-b",
      sourceTurnId: "turn-b",
      summary: "第二个可保存任务",
    }));
    turns.get("sess-a")?.push(second);
  }
  if (options.twoEligibleTurns) {
    turns.get("sess-a")?.push(answerTurn("b", "已完成第二个任务"));
  }
  const confirmAttempts = new Map<string, number>();
  let dismissAttempts = 0;
  let requestAttempts = 0;
  let createdRequestCount = 0;
  const initialBlockSequences = [...turns.values()].flatMap((sessionTurns) =>
    sessionTurns.flatMap((turn) => turn.blocks.flatMap((block) => {
      const sequence = block.metadata.event_sequence;
      return typeof sequence === "number" && Number.isFinite(sequence) ? [sequence] : [];
    })),
  );
  let canonicalSequence = Math.max(10, ...initialBlockSequences);
  const canonicalWrites: Array<{
    kind: "initial" | "request" | "confirm" | "dismiss" | "unrelated";
    sequence: number;
    requestId?: string;
  }> = [{ kind: "initial", sequence: canonicalSequence }];
  let applyCalls = 0;
  let reviewContextResponses = 0;
  const requestKeys: string[] = [];
  const confirmKeys: string[] = [];
  const confirmCalls: Array<{ requestId: string; key: string }> = [];
  const dismissKeys: string[] = [];
  const messageBodies: Record<string, unknown>[] = [];
  let publishCommittedRequest!: (value: { requestId: string; sourceRunId: string }) => void;
  const committedRequest = new Promise<{ requestId: string; sourceRunId: string }>((resolve) => {
    publishCommittedRequest = resolve;
  });
  let committedRequestDelivered = false;
  let publishCommittedTerminal!: (value: {
    requestId: string;
    sourceRunId: string;
    sequence: number;
    type: "FLOW_CANDIDATE_CREATED" | "FLOW_SAVE_DISMISSED";
  }) => void;
  const committedTerminal = new Promise<{
    requestId: string;
    sourceRunId: string;
    sequence: number;
    type: "FLOW_CANDIDATE_CREATED" | "FLOW_SAVE_DISMISSED";
  }>((resolve) => {
    publishCommittedTerminal = resolve;
  });
  let committedTerminalDelivered = false;
  let publishUnknownRequest!: () => void;
  const unknownRequestObserved = new Promise<void>((resolve) => {
    publishUnknownRequest = resolve;
  });
  let unrelatedEventDelivered = false;

  const snapshot = (value: ReturnType<typeof session>) => ({
    session: value,
    runtime: {
      active_run: null,
      queue_state: "ready",
      queue_pause_reason: null,
      queue: { turns: [], total: 0, next_cursor: null },
      version: 1,
      last_event_sequence: canonicalSequence,
    },
    timeline: {
      turns: turns.get(value.session_id) ?? [],
      previous_cursor: null,
      truncated_block_ids: [],
    },
    commands: [],
    events: [],
    options: [],
    runs: [],
  });

  await page.addInitScript((selected) => {
    (globalThis as typeof globalThis & { process?: { env: Record<string, string> } }).process = { env: {} };
    localStorage.setItem("codebridge:last-session:codex", selected);
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
  await page.route(/\/v1\/flows(?:\?.*)?$/, (route) => {
    const flowList = turns.get("sess-a")?.[0]?.blocks.some((block) =>
      block.kind === "flow_save_request" && block.status === "completed"
    ) ? [candidate] : [];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ flows: flowList }),
    });
  });
  await page.route("**/v1/capabilities", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ capabilities: [] }),
  }));
  await page.route(`**/v1/flows/${candidate.flow_id}/review-context`, async (route) => {
    if (options.delayedReviewContext) {
      options.delayedReviewContext.onStarted();
      await options.delayedReviewContext.wait;
      if (options.delayedReviewContext.status) {
        await route.fulfill({
          status: options.delayedReviewContext.status,
          contentType: "application/json",
          body: JSON.stringify({ error: "review_context_from_session_a_failed" }),
        });
        reviewContextResponses += 1;
        return;
      }
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
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
      }),
    });
    reviewContextResponses += 1;
  });
  await page.route(`**/v1/flows/${candidate.flow_id}`, (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(candidate),
  }));
  await page.route("**/v1/flows/*/apply", (route) => {
    applyCalls += 1;
    return route.fulfill({ status: 500, body: "must not bind" });
  });

  for (const value of sessions) {
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
    await page.route(`**/v1/sessions/${value.session_id}/events*`, async (route) => {
      if (
        value.session_id === "sess-a"
        && options.requestCommitsThenDisconnectOnce
        && !committedRequestDelivered
      ) {
        const committed = await committedRequest;
        committedRequestDelivered = true;
        const delivery = options.committedRequestDelivery ?? "sse";
        const event = delivery === "sse"
          ? {
              schema_version: 1,
              event_id: "evt_flow_save_requested",
              sequence: canonicalSequence,
              work_item_id: "work_sess_a",
              run_id: committed.sourceRunId,
              execution_kind: "agent",
              type: "FLOW_SAVE_REQUESTED",
              occurred_at: "2026-08-25T00:00:01.000Z",
              actor: "user",
              target: committed.requestId,
              input_hash: "flow-save-request:test",
              result_ref: null,
              payload: {
                request_id: committed.requestId,
                session_id: "sess-a",
                request_turn_id: "turn-a",
                request_run_id: committed.sourceRunId,
                source_turn_id: "turn-a",
                source_run_id: committed.sourceRunId,
                source: "turn_action",
                user_message: "查询公司权益并核对交付",
                source_imported: false,
              },
            }
          : {
              schema_version: 1,
              event_id: "evt_gap_after_flow_save",
              sequence: canonicalSequence + 1,
              work_item_id: "work_sess_a",
              run_id: committed.sourceRunId,
              execution_kind: "agent",
              type: "RUN_SUCCEEDED",
              occurred_at: "2026-08-25T00:00:02.000Z",
              actor: "system",
              target: null,
              input_hash: null,
              result_ref: null,
              payload: {},
            };
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify(event)}\n\n`,
        });
        return;
      }
      if (
        value.session_id === "sess-a"
        && (options.confirmCommitsThenDisconnectOnce || options.dismissCommitsThenDisconnectOnce)
        && !committedTerminalDelivered
      ) {
        const terminal = await committedTerminal;
        committedTerminalDelivered = true;
        if (options.delayedTerminalDelivery) {
          options.delayedTerminalDelivery.onStarted();
          await options.delayedTerminalDelivery.wait;
        }
        const delivery = options.terminalDelivery ?? "sse";
        const event = delivery === "sse"
          ? {
              schema_version: 1,
              event_id: "evt_flow_save_terminal",
              sequence: terminal.sequence,
              work_item_id: "work_sess_a",
              run_id: terminal.sourceRunId,
              execution_kind: "agent",
              type: terminal.type,
              occurred_at: "2026-08-25T00:00:04.000Z",
              actor: "user",
              target: terminal.requestId,
              input_hash: "flow-save-terminal:test",
              result_ref: null,
              payload: {
                request_id: terminal.requestId,
                session_id: "sess-a",
                source_run_id: terminal.sourceRunId,
                ...(terminal.type === "FLOW_CANDIDATE_CREATED"
                  ? {
                      flow_id: candidate.flow_id,
                      definition_revision: candidate.definition_revision,
                      name_hint: candidate.name,
                    }
                  : {}),
              },
            }
          : {
              schema_version: 1,
              event_id: "evt_gap_after_flow_save_terminal",
              sequence: terminal.sequence + 1,
              work_item_id: "work_sess_a",
              run_id: terminal.sourceRunId,
              execution_kind: "agent",
              type: "RUN_SUCCEEDED",
              occurred_at: "2026-08-25T00:00:05.000Z",
              actor: "system",
              target: null,
              input_hash: null,
              result_ref: null,
              payload: {},
            };
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify(event)}\n\n`,
        });
        return;
      }
      if (
        value.session_id === "sess-a"
        && options.unrelatedEventAfterUnknown
        && !unrelatedEventDelivered
      ) {
        await unknownRequestObserved;
        unrelatedEventDelivered = true;
        canonicalSequence += 1;
        canonicalWrites.push({ kind: "unrelated", sequence: canonicalSequence });
        await route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body: `data: ${JSON.stringify({
            schema_version: 1,
            event_id: "evt_unrelated_after_request",
            sequence: canonicalSequence,
            work_item_id: "work_sess_a",
            run_id: "run-a",
            execution_kind: "agent",
            type: "RUN_SUCCEEDED",
            occurred_at: "2026-08-25T00:00:03.000Z",
            actor: "system",
            target: null,
            input_hash: null,
            result_ref: null,
            payload: {},
          })}\n\n`,
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: ": keep-alive\n\n",
      });
    });
    await page.route(`**/v1/sessions/${value.session_id}/messages`, async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}") as Record<string, unknown>;
      messageBodies.push(body);
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          event_id: "evt_dry_run",
          sequence: 20,
          acceptance: "dispatched",
          turn: {
            turn_id: "turn_dry_run",
            queue_position: 0,
            status: "dispatched",
            version: 1,
            message: { text: String(body.message ?? ""), attachment_ids: [] },
            created_at: "2026-08-25T00:00:00.000Z",
          },
          runtime: {
            active_run: null,
            queue_state: "ready",
            queue_pause_reason: null,
            queue: { turns: [], total: 0, next_cursor: null },
            version: 2,
            last_event_sequence: 20,
          },
        }),
      });
    });
  }

  await page.route("**/v1/sessions/sess-a/flow-save-requests", async (route) => {
    requestAttempts += 1;
    requestKeys.push(route.request().headers()["idempotency-key"] ?? "");
    if (options.delayedRequest) await options.delayedRequest.wait;
    if (options.requestUnknownOnce && requestAttempts === 1) {
      publishUnknownRequest();
      await route.abort("connectionfailed");
      return;
    }
    const source = turns.get("sess-a")![0]!;
    const blocking = source.blocks.find((block) =>
      block.kind === "flow_save_request"
      && ["pending", "completed"].includes(block.status)
      && block.metadata.source_run_id === "run-a"
    );
    let requestId = typeof blocking?.metadata.request_id === "string"
      ? blocking.metadata.request_id
      : null;
    if (!requestId) {
      createdRequestCount += 1;
      requestId = createdRequestCount === 1 ? "fsr_one" : `fsr_reopened_${createdRequestCount}`;
      canonicalSequence += 1;
      canonicalWrites.push({ kind: "request", sequence: canonicalSequence, requestId });
      source.blocks.push(requestBlock({
        imported: options.imported,
        requestId,
        eventSequence: canonicalSequence,
      }));
    }
    if (options.requestCommitsThenDisconnectOnce && requestAttempts === 1) {
      publishCommittedRequest({ requestId, sourceRunId: "run-a" });
      await route.abort("connectionfailed");
      return;
    }
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        state: "requested",
        request: requestRecord(options.imported, requestId),
      }),
    });
  });

  await page.route("**/v1/flow-save-requests/*/confirm", async (route) => {
    const match = new URL(route.request().url()).pathname.match(/flow-save-requests\/([^/]+)\/confirm$/);
    const requestId = decodeURIComponent(match?.[1] ?? "");
    const attempt = (confirmAttempts.get(requestId) ?? 0) + 1;
    confirmAttempts.set(requestId, attempt);
    const key = route.request().headers()["idempotency-key"] ?? "";
    confirmKeys.push(key);
    confirmCalls.push({ requestId, key });
    if (requestId === "fsr_one" && options.delayedConfirm) await options.delayedConfirm.wait;
    const block = turns.get("sess-a")
      ?.flatMap((turn) => turn.blocks)
      .find((entry) => entry.block_id === `flow_save:${requestId}`);
    const sourceRunId = requestId === "fsr_two" ? "run-b" : "run-a";
    const sourceTurnId = requestId === "fsr_two" ? "turn-b" : "turn-a";
    if (requestId === "fsr_one" && options.confirmCommitsThenDisconnectOnce && attempt === 1) {
      canonicalSequence += 1;
      canonicalWrites.push({ kind: "confirm", sequence: canonicalSequence, requestId });
      if (block) Object.assign(block, requestBlock({
        status: "completed",
        requestId,
        sourceRunId,
        sourceTurnId,
        eventSequence: canonicalSequence,
      }));
      publishCommittedTerminal({
        requestId,
        sourceRunId,
        sequence: canonicalSequence,
        type: "FLOW_CANDIDATE_CREATED",
      });
      await route.abort("connectionfailed");
      return;
    }
    if (requestId === "fsr_one" && options.confirmMode === "unknown-once" && attempt === 1) {
      if (options.unrelatedEventAfterUnknown) publishUnknownRequest();
      await route.abort("connectionfailed");
      return;
    }
    if (requestId === "fsr_one" && options.confirmMode === "unavailable-once" && attempt === 1) {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "flow_catalog_unavailable" }),
      });
      return;
    }
    if (requestId === "fsr_one" && options.confirmMode === "failed") {
      canonicalSequence += 1;
      canonicalWrites.push({ kind: "confirm", sequence: canonicalSequence, requestId });
      if (block) Object.assign(block, requestBlock({
        status: "failed",
        errorCode: "source_run_not_extractable",
        requestId,
        sourceRunId,
        sourceTurnId,
        eventSequence: canonicalSequence,
      }));
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({ error: "source_run_not_extractable" }),
      });
      return;
    }
    canonicalSequence += 1;
    canonicalWrites.push({ kind: "confirm", sequence: canonicalSequence, requestId });
    if (block) Object.assign(block, requestBlock({
      status: "completed",
      requestId,
      sourceRunId,
      sourceTurnId,
      eventSequence: canonicalSequence,
    }));
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        state: "completed",
        request: requestRecord(options.imported, requestId, sourceRunId),
        flow: candidate,
      }),
    });
  });

  await page.route("**/v1/flow-save-requests/fsr_one/dismiss", async (route) => {
    dismissAttempts += 1;
    dismissKeys.push(route.request().headers()["idempotency-key"] ?? "");
    const source = turns.get("sess-a")![0]!;
    const block = source.blocks.find((entry) => entry.kind === "flow_save_request");
    if (options.dismissCommitsThenDisconnectOnce && dismissAttempts === 1) {
      canonicalSequence += 1;
      canonicalWrites.push({ kind: "dismiss", sequence: canonicalSequence, requestId: "fsr_one" });
      if (block) Object.assign(block, requestBlock({
        status: "dismissed",
        imported: options.imported,
        eventSequence: canonicalSequence,
      }));
      publishCommittedTerminal({
        requestId: "fsr_one",
        sourceRunId: "run-a",
        sequence: canonicalSequence,
        type: "FLOW_SAVE_DISMISSED",
      });
      await route.abort("connectionfailed");
      return;
    }
    if (options.dismissUnknownOnce && dismissAttempts === 1) {
      if (options.unrelatedEventAfterUnknown) publishUnknownRequest();
      await route.abort("connectionfailed");
      return;
    }
    canonicalSequence += 1;
    canonicalWrites.push({ kind: "dismiss", sequence: canonicalSequence, requestId: "fsr_one" });
    if (block) Object.assign(block, requestBlock({
      status: "dismissed",
      imported: options.imported,
      eventSequence: canonicalSequence,
    }));
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ state: "dismissed", request: requestRecord(options.imported) }),
    });
  });

  return {
    requestKeys,
    confirmKeys,
    confirmCalls,
    dismissKeys,
    messageBodies,
    canonicalWrites,
    reviewContextResponses: () => reviewContextResponses,
    unrelatedEventDeliveries: () => Number(unrelatedEventDelivered),
    applyCalls: () => applyCalls,
  };
}

async function openSaveRequest(page: Page) {
  await page.goto("/workbench/");
  await page.getByRole("button", { name: "Turn 操作" }).click();
  await page.getByRole("button", { name: "存为 Flow" }).click();
  await expect(page.locator('[data-flow-save-request="pending"]')).toBeVisible();
}

test("Turn action persists across refresh and confirm opens one unbound Candidate", async ({ page }) => {
  const fixture = await installFixture(page);
  await openSaveRequest(page);
  expect(fixture.requestKeys).toHaveLength(1);

  await page.reload();
  await expect(page.locator('[data-flow-save-request="pending"]')).toBeVisible();
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.locator('[data-flow-save-request="completed"]')).toBeVisible();
  await page.getByRole("button", { name: "Dry-run 预演" }).click();
  await expect.poll(() => fixture.messageBodies.length).toBe(1);
  expect(fixture.messageBodies[0]).toMatchObject({
    flow_id: candidate.flow_id,
    definition_revision: candidate.definition_revision,
    dry_run: true,
  });
  expect(fixture.confirmKeys).toHaveLength(1);
  expect(fixture.applyCalls()).toBe(0);
});

for (const source of ["confirm", "completed-card"] as const) {
  test(`${source} Candidate detail cannot cross from Session A into Session B`, async ({ page }) => {
    let releaseReview!: () => void;
    let markReviewStarted!: () => void;
    const reviewWait = new Promise<void>((resolve) => { releaseReview = resolve; });
    const reviewStarted = new Promise<void>((resolve) => { markReviewStarted = resolve; });
    const fixture = await installFixture(page, {
      initialBlock: source === "completed-card" ? requestBlock({ status: "completed" }) : null,
      sessions: [session("sess-a", "Session A"), session("sess-b", "Session B")],
      delayedReviewContext: { wait: reviewWait, onStarted: markReviewStarted },
    });
    await page.goto("/workbench/");
    if (source === "confirm") {
      await page.getByRole("button", { name: "Turn 操作" }).click();
      await page.getByRole("button", { name: "存为 Flow" }).click();
      await expect(page.locator('[data-flow-save-request="pending"]')).toBeVisible();
      await page.getByRole("button", { name: "生成 Candidate" }).click();
    } else {
      await page.getByRole("button", { name: "打开并预演" }).click();
    }
    await reviewStarted;
    await page.getByText("Session B", { exact: true }).first().click();
    await expect(page.getByText("已完成 Session B")).toBeVisible();
    releaseReview();
    await expect.poll(fixture.reviewContextResponses).toBe(1);
    await expect(page.getByRole("button", { name: "Dry-run 预演" })).toHaveCount(0);
  });
}

for (const source of ["confirm", "completed-card"] as const) {
  test(`${source} review failure cannot surface in Session B after switching from Session A`, async ({ page }) => {
    let releaseReview!: () => void;
    let markReviewStarted!: () => void;
    const reviewWait = new Promise<void>((resolve) => { releaseReview = resolve; });
    const reviewStarted = new Promise<void>((resolve) => { markReviewStarted = resolve; });
    const fixture = await installFixture(page, {
      initialBlock: source === "completed-card" ? requestBlock({ status: "completed" }) : null,
      sessions: [session("sess-a", "Session A"), session("sess-b", "Session B")],
      delayedReviewContext: { wait: reviewWait, onStarted: markReviewStarted, status: 500 },
    });
    await page.goto("/workbench/");
    if (source === "confirm") {
      await page.getByRole("button", { name: "Turn 操作" }).click();
      await page.getByRole("button", { name: "存为 Flow" }).click();
      await expect(page.locator('[data-flow-save-request="pending"]')).toBeVisible();
      await page.getByRole("button", { name: "生成 Candidate" }).click();
    } else {
      await page.getByRole("button", { name: "打开并预演" }).click();
    }
    await reviewStarted;
    await page.getByText("Session B", { exact: true }).first().click();
    await expect(page.getByText("已完成 Session B")).toBeVisible();
    releaseReview();
    await expect.poll(fixture.reviewContextResponses).toBe(1);
    await page.waitForTimeout(100);
    expect(await page.getByText("HTTP 500", { exact: false }).count()).toBe(0);
    await expect(page.getByRole("button", { name: "Dry-run 预演" })).toHaveCount(0);
  });
}

test("Turn action Popovers support keyboard focus, Escape, outside close, and one-open convergence", async ({ page }) => {
  await installFixture(page, { twoEligibleTurns: true });
  await page.goto("/workbench/");
  const triggers = page.getByRole("button", { name: "Turn 操作" });
  await expect(triggers).toHaveCount(2);

  await triggers.nth(0).focus();
  await page.keyboard.press("Enter");
  const action = page.getByRole("button", { name: "存为 Flow" });
  await expect(action).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(action).toHaveCount(0);
  await expect(triggers.nth(0)).toBeFocused();

  await page.keyboard.press("Space");
  await expect(page.getByRole("button", { name: "存为 Flow" })).toBeVisible();
  await page.locator("header").first().click({ position: { x: 4, y: 4 } });
  await expect(page.getByRole("button", { name: "存为 Flow" })).toHaveCount(0);

  await triggers.nth(0).click();
  await expect(page.getByRole("button", { name: "存为 Flow" })).toHaveCount(1);
  await triggers.nth(1).click();
  await expect(page.getByRole("button", { name: "存为 Flow" })).toHaveCount(1);
});

test("dismiss and imported provenance remain visible after refresh", async ({ page }) => {
  const fixture = await installFixture(page, { imported: true });
  await openSaveRequest(page);
  await expect(page.getByText("来源为导入历史，请确认其步骤仍然适用。")).toBeVisible();
  await page.getByRole("button", { name: "忽略" }).click();
  await expect(page.locator('[data-flow-save-request="dismissed"]')).toBeVisible();
  await page.reload();
  await expect(page.locator('[data-flow-save-request="dismissed"]')).toBeVisible();
  await page.getByRole("button", { name: "Turn 操作" }).click();
  await page.getByRole("button", { name: "存为 Flow" }).click();
  expect(fixture.requestKeys).toHaveLength(2);
  expect(fixture.requestKeys[1]).not.toBe(fixture.requestKeys[0]);
});

test("unknown confirm outcome retries with the same key", async ({ page }) => {
  const fixture = await installFixture(page, { confirmMode: "unknown-once" });
  await openSaveRequest(page);
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.getByText("生成结果未知，请使用同一次确认重试。")).toBeVisible();
  await page.getByRole("button", { name: "重试生成" }).click();
  await expect(page.locator('[data-flow-save-request="completed"]')).toBeVisible();
  expect(fixture.confirmKeys).toHaveLength(2);
  expect(fixture.confirmKeys[1]).toBe(fixture.confirmKeys[0]);
});

test("an older terminal block cannot clear a newer unknown confirm command", async ({ page }) => {
  const oldTerminal = requestBlock({ status: "dismissed", eventSequence: 9 });
  oldTerminal.block_id = "flow_save:fsr_one:old-terminal";
  const fixture = await installFixture(page, {
    concurrentRequests: true,
    confirmMode: "unknown-once",
    initialBlock: oldTerminal,
    unrelatedEventAfterUnknown: true,
  });
  await page.goto("/workbench/");
  const pending = page.locator('[data-flow-save-request="pending"][data-flow-save-request-id="fsr_one"]');
  await pending.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(pending.getByRole("button", { name: "重试生成" })).toBeVisible();
  await expect.poll(fixture.unrelatedEventDeliveries).toBe(1);
  await pending.getByRole("button", { name: "重试生成" }).click();
  await expect(page.locator('[data-flow-save-request="completed"][data-flow-save-request-id="fsr_one"]'))
    .toBeVisible();
  expect(fixture.confirmKeys).toHaveLength(2);
  expect(fixture.confirmKeys[1]).toBe(fixture.confirmKeys[0]);
});

test("unknown dismiss outcome only retries dismiss with the same key", async ({ page }) => {
  const fixture = await installFixture(page, {
    dismissUnknownOnce: true,
    initialBlock: requestBlock(),
  });
  await page.goto("/workbench/");
  const card = page.locator('[data-flow-save-request-id="fsr_one"]');
  await card.getByRole("button", { name: "忽略" }).click();
  await expect(card.getByText("忽略结果未知，请再次点击“忽略”安全重试。")).toBeVisible();
  await expect(card.getByRole("button", { name: "生成 Candidate" })).toHaveCount(0);
  await card.getByRole("button", { name: "重试忽略" }).click();
  await expect(card).toHaveAttribute("data-flow-save-request", "dismissed");
  expect(fixture.dismissKeys).toHaveLength(2);
  expect(fixture.dismissKeys[1]).toBe(fixture.dismissKeys[0]);
});

for (const operation of ["confirm", "dismiss"] as const) {
  for (const delivery of ["sse", "hydrate"] as const) {
    test(`canonical ${delivery} terminal reconciles an unknown ${operation}`, async ({ page }) => {
      let releaseTerminal!: () => void;
      let markTerminalStarted!: () => void;
      const terminalWait = new Promise<void>((resolve) => { releaseTerminal = resolve; });
      const terminalStarted = new Promise<void>((resolve) => { markTerminalStarted = resolve; });
      await installFixture(page, {
        confirmCommitsThenDisconnectOnce: operation === "confirm",
        dismissCommitsThenDisconnectOnce: operation === "dismiss",
        initialBlock: requestBlock(),
        terminalDelivery: delivery,
        delayedTerminalDelivery: { wait: terminalWait, onStarted: markTerminalStarted },
      });
      await page.goto("/workbench/");
      const card = page.locator('[data-flow-save-request-id="fsr_one"]');
      await card.getByRole("button", {
        name: operation === "confirm" ? "生成 Candidate" : "忽略",
      }).click();
      await terminalStarted;
      await expect(card.getByText(operation === "confirm"
        ? "生成结果未知，请使用同一次确认重试。"
        : "忽略结果未知，请再次点击“忽略”安全重试。"))
        .toBeVisible();
      releaseTerminal();
      await expect(card).toHaveAttribute(
        "data-flow-save-request",
        operation === "confirm" ? "completed" : "dismissed",
      );
      await expect(card.getByRole("button", { name: /重试/ })).toHaveCount(0);
    });
  }
}

test("two pending cards keep independent keys while A unknown result retries its original key", async ({ page }) => {
  let releaseA!: () => void;
  const waitForA = new Promise<void>((resolve) => { releaseA = resolve; });
  const fixture = await installFixture(page, {
    concurrentRequests: true,
    confirmMode: "unknown-once",
    delayedConfirm: { wait: waitForA },
  });
  await page.goto("/workbench/");
  const cardA = page.locator('[data-flow-save-request-id="fsr_one"]');
  const cardB = page.locator('[data-flow-save-request-id="fsr_two"]');
  await expect(cardA).toBeVisible();
  await expect(cardB).toBeVisible();

  await cardA.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(cardA.getByRole("button", { name: "正在生成 Candidate" })).toBeDisabled();
  await cardB.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(cardB).toHaveAttribute("data-flow-save-request", "completed");
  releaseA();
  await expect(cardA.getByText("生成结果未知，请使用同一次确认重试。")).toBeVisible();
  await expect(cardA.getByRole("button", { name: "忽略" })).toHaveCount(0);
  await cardA.getByRole("button", { name: "重试生成" }).click();
  await expect(cardA).toHaveAttribute("data-flow-save-request", "completed");

  const callsA = fixture.confirmCalls.filter((call) => call.requestId === "fsr_one");
  const callsB = fixture.confirmCalls.filter((call) => call.requestId === "fsr_two");
  expect(callsA).toHaveLength(2);
  expect(callsB).toHaveLength(1);
  expect(callsA[1]!.key).toBe(callsA[0]!.key);
  expect(callsB[0]!.key).not.toBe(callsA[0]!.key);
});

test("unknown request outcome retries the Turn action with the same caller key", async ({ page }) => {
  const fixture = await installFixture(page, { requestUnknownOnce: true });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: "Turn 操作" }).click();
  await page.getByRole("button", { name: "存为 Flow" }).click();
  await expect(page.getByText("保存请求结果未知；再次选择“存为 Flow”会安全重试同一请求。")).toBeVisible();
  await page.getByRole("button", { name: "Turn 操作" }).click();
  await page.getByRole("button", { name: "存为 Flow" }).click();
  await expect(page.locator('[data-flow-save-request="pending"]')).toBeVisible();
  expect(fixture.requestKeys).toHaveLength(2);
  expect(fixture.requestKeys[0]).not.toBe("");
  expect(fixture.requestKeys[1]).toBe(fixture.requestKeys[0]);
});

for (const scenario of [
  {
    label: "older matching request block",
    block: requestBlock({ status: "dismissed", requestId: "fsr_old", eventSequence: 9 }),
  },
  {
    label: "pre-existing higher request sequence",
    block: requestBlock({ status: "dismissed", requestId: "fsr_future", eventSequence: 99 }),
  },
  {
    label: "foreign source request block",
    block: requestBlock({
      status: "dismissed",
      requestId: "fsr_foreign_source",
      sourceRunId: "run-foreign",
      sourceTurnId: "turn-foreign",
      eventSequence: 99,
    }),
  },
  {
    label: "foreign Session request block",
    block: requestBlock({
      status: "dismissed",
      requestId: "fsr_foreign_session",
      sessionId: "sess-foreign",
      eventSequence: 99,
    }),
  },
]) {
  test(`${scenario.label} cannot clear a new unknown request key`, async ({ page }) => {
    const fixture = await installFixture(page, {
      initialBlock: scenario.block,
      requestUnknownOnce: true,
      unrelatedEventAfterUnknown: true,
    });
    await page.goto("/workbench/");
    await page.getByRole("button", { name: "Turn 操作" }).click();
    await page.getByRole("button", { name: "存为 Flow" }).click();
    await expect(page.getByText("保存请求结果未知；再次选择“存为 Flow”会安全重试同一请求。"))
      .toBeVisible();
    await expect.poll(fixture.unrelatedEventDeliveries).toBe(1);

    await page.getByRole("button", { name: "Turn 操作" }).click();
    await page.getByRole("button", { name: "存为 Flow" }).click();
    await expect(page.locator('[data-flow-save-request="pending"]')).toBeVisible();
    expect(fixture.requestKeys).toHaveLength(2);
    expect(fixture.requestKeys[1]).toBe(fixture.requestKeys[0]);
    if (scenario.label === "pre-existing higher request sequence") {
      expect(fixture.canonicalWrites).toEqual([
        { kind: "initial", sequence: 99 },
        { kind: "unrelated", sequence: 100 },
        { kind: "request", sequence: 101, requestId: "fsr_one" },
      ]);
    }
  });
}

for (const delivery of ["sse", "hydrate"] as const) {
  test(`canonical ${delivery} request clears an unknown caller key before a later explicit request`, async ({ page }) => {
    const fixture = await installFixture(page, {
      requestCommitsThenDisconnectOnce: true,
      committedRequestDelivery: delivery,
    });
    await page.goto("/workbench/");
    await page.getByRole("button", { name: "Turn 操作" }).click();
    await page.getByRole("button", { name: "存为 Flow" }).click();

    const first = page.locator('[data-flow-save-request="pending"]');
    await expect(first).toBeVisible();
    await expect(first).toHaveAttribute("data-flow-save-request-id", "fsr_one");
    await first.getByRole("button", { name: "忽略" }).click();
    await expect(page.locator('[data-flow-save-request-id="fsr_one"]'))
      .toHaveAttribute("data-flow-save-request", "dismissed");

    await page.getByRole("button", { name: "Turn 操作" }).click();
    await page.getByRole("button", { name: "存为 Flow" }).click();
    const reopened = page.locator('[data-flow-save-request="pending"]');
    await expect(reopened).toHaveAttribute("data-flow-save-request-id", "fsr_reopened_2");

    expect(fixture.requestKeys).toHaveLength(2);
    expect(fixture.requestKeys[1]).not.toBe(fixture.requestKeys[0]);
  });
}

test("known 503 keeps pending and a later explicit retry uses a new key", async ({ page }) => {
  const fixture = await installFixture(page, { confirmMode: "unavailable-once" });
  await openSaveRequest(page);
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.getByText("Flow Catalog 暂不可用，请重试生成。")).toBeVisible();
  await page.getByRole("button", { name: "重试生成" }).click();
  await expect(page.locator('[data-flow-save-request="completed"]')).toBeVisible();
  expect(fixture.confirmKeys[1]).not.toBe(fixture.confirmKeys[0]);
});

test("deterministic source failure renders the persisted reason without same-request retry", async ({ page }) => {
  await installFixture(page, { confirmMode: "failed" });
  await openSaveRequest(page);
  await page.getByRole("button", { name: "生成 Candidate" }).click();
  await expect(page.locator('[data-flow-save-request="failed"]')).toBeVisible();
  await expect(page.getByText("source_run_not_extractable")).toBeVisible();
  await expect(page.getByRole("button", { name: "重试生成" })).toHaveCount(0);
});

test("late Session A request cannot create or update a card in Session B", async ({ page }) => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => { release = resolve; });
  await installFixture(page, {
    delayedRequest: { wait },
    sessions: [session("sess-a", "Session A"), session("sess-b", "Session B")],
  });
  await page.goto("/workbench/");
  await page.getByRole("button", { name: "Turn 操作" }).click();
  await page.getByRole("button", { name: "存为 Flow" }).click();
  await page.getByText("Session B", { exact: true }).first().click();
  await expect(page.getByText("已完成 Session B")).toBeVisible();
  release();
  await expect(page.locator("[data-flow-save-request]")).toHaveCount(0);
});

for (const scenario of [
  {
    label: "pending long source",
    status: "pending" as const,
    block: requestBlock({ summary: "https://example.com/" + "unbroken".repeat(600) }),
  },
  {
    label: "completed long Candidate name",
    status: "completed" as const,
    block: requestBlock({ status: "completed", nameHint: "candidate_" + "unbroken".repeat(600) }),
  },
  {
    label: "failed long reason",
    status: "failed" as const,
    block: requestBlock({ status: "failed", errorCode: "flow_save_" + "unbroken".repeat(600) }),
  },
]) {
  test(`${scenario.label} stays contained from 320 through 1536 pixels`, async ({ page }) => {
    await installFixture(page, { initialBlock: scenario.block });
    await page.goto("/workbench/");
    for (const width of [320, 768, 1280, 1536]) {
      await page.setViewportSize({ width, height: 900 });
      const card = page.locator(`[data-flow-save-request="${scenario.status}"]`);
      await expect(card).toBeVisible();
      const overflow = await page.evaluate(() => ({
        document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        card: (() => {
          const element = document.querySelector<HTMLElement>("[data-flow-save-request]");
          return element ? element.scrollWidth - element.clientWidth : -1;
        })(),
      }));
      expect(overflow.document, `document overflow at ${width}`).toBeLessThanOrEqual(0);
      expect(overflow.card, `card overflow at ${width}`).toBeLessThanOrEqual(0);
    }
  });
}
