# Agent Setup and Default Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add install/configuration diagnostics for every supported Agent, a safe OpenCode install path, and a persisted default Agent that controls the Agent selected after a page refresh.

**Architecture:** Runner Host owns host-local detection and allowlisted installation; Bridge projects setup state through the Agent registry and persists only `defaultAgent`; Web renders setup cards and derives all enable/disable behavior from server-provided eligibility. No setup or routing metadata is injected into prompts.

**Tech Stack:** TypeScript, Node.js `spawn`, Hono, Zod, React, Vitest, pnpm

---

## File map

- `packages/core/src/config-schema.ts`: persist the optional default Agent without a fixed Agent enum.
- `packages/session-catalog/src/index.ts`: define setup-state fields shared by Registry, Bridge, and Web.
- `packages/agent-registry/src/index.ts`: retain setup state and derive compatibility status/default eligibility.
- `packages/agent-registry/src/setup.ts`: supported-Agent manifests and pure eligibility/status helpers.
- `packages/agent-registry/src/index.test.ts`: Registry setup-state and default-candidate tests.
- `packages/backends/src/agent-setup.ts`: host-local executable/configuration probes, safe install execution, stderr redaction.
- `packages/backends/src/agent-setup.test.ts`: probe/install/redaction tests with injected process runners.
- `packages/backends/src/index.ts`: export setup contracts.
- `packages/runner-host/src/server.ts`: authenticated setup list, detect, and install endpoints.
- `packages/runner-client/src/index.ts`: typed setup API client.
- `apps/bridge/src/cli.ts`: refresh Registry from Runner setup state and supply ConfigStore to the API.
- `apps/bridge/src/session-api.ts`: return setup/default metadata and validate default-Agent updates.
- `apps/bridge/src/session-api.test.ts`: API status/error/default persistence tests.
- `apps/web/src/lib/types.ts`: setup/default response contracts.
- `apps/web/src/lib/api.ts`: setup refresh/install/default methods.
- `apps/web/src/lib/workbench-logic.ts`: pure initial Agent selection helper.
- `apps/web/src/lib/workbench-logic.test.ts`: refresh/default/fallback routing tests.
- `apps/web/src/components/settings-page.tsx`: Agent setup cards and default controls.
- `apps/web/src/components/session-chrome.tsx`: setup-aware Rail affordances without status dots.
- `apps/web/src/components/workbench.tsx`: use effective default on initial load and show setup state.

### Task 1: Shared setup and default contracts

**Files:**
- Modify: `packages/core/src/config-schema.ts`
- Modify: `packages/session-catalog/src/index.ts`
- Create: `packages/agent-registry/src/setup.ts`
- Modify: `packages/agent-registry/src/index.ts`
- Test: `packages/agent-registry/src/index.test.ts`

- [ ] **Step 1: Write failing Registry tests**

Add tests proving:

```ts
const missing = registry.register({
  ...profile,
  setup: {
    installation: "missing",
    configuration: "unknown",
    runtime: "not_started",
    canSelectDefault: false,
    canCreateSession: false,
  },
});
expect(missing.status).toBe("needs_setup");
expect(missing.setup.canSelectDefault).toBe(false);

const ready = registry.updateSetup("pi", {
  installation: "installed",
  configuration: "configured",
  runtime: "healthy",
});
expect(ready?.status).toBe("healthy");
expect(ready?.setup.canSelectDefault).toBe(true);
```

- [ ] **Step 2: Run the focused tests and confirm failure**

Run: `pnpm --filter @codebridge/agent-registry test`

Expected: FAIL because `setup` and `updateSetup` do not exist.

- [ ] **Step 3: Add shared setup types and pure projection**

Define `AgentSetupState`, `AgentDiagnostic`, `AgentInstallStrategy`, and `AgentSetupManifest`. Add `setup` to `AgentProfile`. Implement:

```ts
export function projectSetupState(
  state: Omit<AgentSetupState, "canSelectDefault" | "canCreateSession">,
): AgentSetupState {
  const canSelectDefault =
    state.installation === "installed" &&
    state.configuration === "configured";
  return {
    ...state,
    canSelectDefault,
    canCreateSession: canSelectDefault && state.runtime === "healthy",
  };
}
```

Add `defaultAgent: z.string().min(1).optional()` to `ConfigSchema`; do not reuse the legacy fixed `defaultBackend` enum.

- [ ] **Step 4: Update Registry cloning and setup projection**

`register()` and `updateSetup()` must clone manifests/strategies, derive `status`, and preserve a saved setup state. `missing` or `needs_configuration` projects to `needs_setup`; a ready but failed runtime projects to `unavailable`.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @codebridge/agent-registry test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/config-schema.ts packages/session-catalog/src/index.ts packages/agent-registry/src/setup.ts packages/agent-registry/src/index.ts packages/agent-registry/src/index.test.ts
git commit -m "feat(agents): define setup state contracts"
```

### Task 2: Host-local detection and safe installation

**Files:**
- Create: `packages/backends/src/agent-setup.ts`
- Create: `packages/backends/src/agent-setup.test.ts`
- Modify: `packages/backends/src/index.ts`

- [ ] **Step 1: Write failing setup-service tests**

Use injected `run(command, args)` and filesystem predicates. Cover:

```ts
expect(await service.detect("opencode")).toMatchObject({
  installation: "missing",
  canSelectDefault: false,
});
expect(await service.install("opencode", "npm-global")).toMatchObject({
  ok: false,
  diagnostic: { stage: "install", code: "install_failed" },
});
expect(redactSetupOutput("Authorization: Bearer secret-token"))
  .not.toContain("secret-token");
```

Also assert an unknown Agent/strategy is rejected before process creation.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm --filter @codebridge/backends test -- agent-setup.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Add five manifests**

Use fixed commands and arguments only:

| Agent | Detection | Safe managed install | Configuration hint |
| --- | --- | --- | --- |
| OpenCode | `opencode --version` | `npm install -g opencode-ai` | `opencode auth login` |
| Codex | `codex --version` | `npm install -g @openai/codex` | `codex login` |
| Claude Code | `claude --version` | `npm install -g @anthropic-ai/claude-code` | `claude` |
| Cursor | `cursor-agent --version`, then `agent --version` | documentation-only | `agent login` |
| Pi | SDK package probe plus Pi models/provider check | project dependency, no global mutation | existing Pi Provider UI |

Managed installation must use `spawn(command, args, { shell: false })`; Cursor exposes only the official documentation URL because its supported installer is a shell pipeline and is outside the allowlisted process model.

- [ ] **Step 4: Implement detection, install, and redaction**

Return stable diagnostics with `stage`, `code`, `message`, safe `details`, and `exitCode`. Cap captured output. Redact bearer headers, common API-key assignments, and `sk-` tokens before returning it.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @codebridge/backends test -- agent-setup.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/agent-setup.ts packages/backends/src/agent-setup.test.ts packages/backends/src/index.ts
git commit -m "feat(agents): detect and install supported agents"
```

### Task 3: Runner setup endpoints and client

**Files:**
- Modify: `packages/runner-host/src/server.ts`
- Modify: `packages/runner-host/src/server.test.ts`
- Modify: `packages/runner-client/src/index.ts`
- Test: `packages/runner-client/src/index.test.ts`

- [ ] **Step 1: Add failing HTTP contract tests**

Cover authenticated:

```text
GET  /agents/setup
POST /agents/:agentId/detect
POST /agents/:agentId/install { strategy_id }
```

Expect `404 agent_not_found`, `400 install_strategy_not_found`, and a structured setup result; verify no arbitrary command is accepted in the body.

- [ ] **Step 2: Run focused tests and confirm failure**

Run: `pnpm --filter @codebridge/runner-host test && pnpm --filter @codebridge/runner-client test`

Expected: FAIL because the endpoints/client methods do not exist.

- [ ] **Step 3: Wire `AgentSetupService` into Runner Host**

Create one service in `RunnerHost`, expose list/detect/install methods, and refresh detection after a successful install. Preserve the existing Runner bearer-token middleware.

- [ ] **Step 4: Add typed RunnerClient methods**

Implement `listAgentSetup()`, `detectAgent(agentId)`, and `installAgent(agentId, strategyId)`. On non-2xx responses, surface the response `message`/`details`, not only the HTTP code.

- [ ] **Step 5: Run focused tests**

Run: `pnpm --filter @codebridge/runner-host test && pnpm --filter @codebridge/runner-client test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runner-host/src/server.ts packages/runner-host/src/server.test.ts packages/runner-client/src/index.ts packages/runner-client/src/index.test.ts
git commit -m "feat(agents): expose setup operations through runner"
```

### Task 4: Bridge Registry projection and default-Agent API

**Files:**
- Modify: `apps/bridge/src/cli.ts`
- Modify: `apps/bridge/src/session-api.ts`
- Modify: `apps/bridge/src/session-api.test.ts`

- [ ] **Step 1: Write failing API tests**

Assert:

```ts
expect(await agentsResponse.json()).toMatchObject({
  default_agent_id: "pi",
  effective_default_agent_id: "pi",
});
```

Cover:

- `PATCH /v1/settings/default-agent` persists an eligible Agent.
- missing Agent returns `409 agent_not_installed`.
- unconfigured Agent returns `409 agent_not_configured`.
- unknown Agent returns `404 agent_not_found`.
- saved invalid default is retained while `effective_default_agent_id` falls back.
- `/v1/agents/:id/detect` and `/install` relay Runner results and update Registry.

- [ ] **Step 2: Run the test and confirm failure**

Run: `pnpm exec vitest run apps/bridge/src/session-api.test.ts`

Expected: FAIL because response metadata and routes do not exist.

- [ ] **Step 3: Extend `SessionApiOptions`**

Supply `ConfigStore`, `AgentRegistry`, and Runner setup methods. Implement one `agentListPayload()` function so list, detect, install, and default updates use the same eligibility calculation.

- [ ] **Step 4: Refresh setup state at startup**

In `cli.ts`, register all five manifests, call Runner `listAgentSetup()`, update each Registry entry, then start runtime health checks only for configured backends. Setup errors remain per-Agent diagnostics.

- [ ] **Step 5: Implement validated default persistence**

Persist with:

```ts
options.configStore.update((current) => ({
  ...current,
  defaultAgent: agentId,
}));
```

Never silently rewrite `defaultAgent` during fallback.

- [ ] **Step 6: Run focused tests**

Run: `pnpm exec vitest run apps/bridge/src/session-api.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/bridge/src/cli.ts apps/bridge/src/session-api.ts apps/bridge/src/session-api.test.ts
git commit -m "feat(agents): persist and route the default agent"
```

### Task 5: Web routing and API contracts

**Files:**
- Modify: `apps/web/src/lib/types.ts`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/lib/workbench-logic.ts`
- Modify: `apps/web/src/lib/workbench-logic.test.ts`
- Modify: `apps/web/src/components/workbench.tsx`

- [ ] **Step 1: Write failing initial-selection tests**

Add:

```ts
expect(selectInitialAgent(agents, "pi")).toBe("pi");
expect(selectInitialAgent(agents, "missing-default")).toBe("codex");
expect(selectInitialAgent(unavailableAgents, null)).toBeNull();
```

Only `setup.canSelectDefault` entries are fallback candidates.

- [ ] **Step 2: Run tests and confirm failure**

Run: `pnpm exec vitest run apps/web/src/lib/workbench-logic.test.ts`

Expected: FAIL because `selectInitialAgent` does not exist.

- [ ] **Step 3: Add setup/default response types and API methods**

Change `api.agents()` to return the complete payload. Add `detectAgent`, `installAgent`, and `setDefaultAgent`.

- [ ] **Step 4: Route initial page load through effective default**

On the first ordinary load, select `effective_default_agent_id`, then restore `codebridge:last-session:{agentId}`. A later silent reload preserves the current selection. Rail clicks never write the default.

- [ ] **Step 5: Run focused tests**

Run: `pnpm exec vitest run apps/web/src/lib/workbench-logic.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/types.ts apps/web/src/lib/api.ts apps/web/src/lib/workbench-logic.ts apps/web/src/lib/workbench-logic.test.ts apps/web/src/components/workbench.tsx
git commit -m "feat(web): restore the configured default agent"
```

### Task 6: Setup UI and unavailable-Agent behavior

**Files:**
- Modify: `apps/web/src/components/settings-page.tsx`
- Modify: `apps/web/src/components/session-chrome.tsx`
- Modify: `apps/web/src/components/workbench.tsx`
- Modify: `apps/web/src/components/design-preview.tsx`

- [ ] **Step 1: Add Agent setup cards**

Before `Providers(Pi)`, render `AGENTS` cards with:

```text
Agent name · default marker
Installed/version
Configured
Runtime/diagnostic
[Install or Open docs] [Configure] [Detect again] [Set as default]
```

Buttons derive from the manifest/setup response. Keep install errors in the card and show stage, stable code, message, details, and exit code.

- [ ] **Step 2: Add explicit install confirmation**

Before calling install, show the exact allowlisted `command` and `args`. The API receives only `strategy_id`.

- [ ] **Step 3: Add setup empty state**

Selecting `needs_setup` in Rail opens an Agent-specific setup state. It must not create a Session, send a message, or select the Agent as default. Do not add status dots.

- [ ] **Step 4: Connect configuration actions**

- Pi scrolls to `Providers(Pi)`.
- Agent-owned configurations show the provided command/path/documentation link.
- No third-party credentials are read or written by the Web application.

- [ ] **Step 5: Update design preview fixtures**

Populate setup fields for healthy, missing, unconfigured, and unavailable states so preview/build type checks remain representative.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/settings-page.tsx apps/web/src/components/session-chrome.tsx apps/web/src/components/workbench.tsx apps/web/src/components/design-preview.tsx
git commit -m "feat(web): add agent setup and default controls"
```

### Task 7: Prompt stability and full verification

**Files:**
- Modify: `packages/backends/src/acp-prompt-turn.test.ts`
- Modify: `packages/backends/src/pi-session-runner.test.ts`
- Modify: `docs/orchestration/agent-providers.md`

- [ ] **Step 1: Add prompt-stability assertions**

Run the same prompt with setup/default metadata changed and assert the adapter request payload is byte-for-byte equal. Setup metadata must never be serialized into `RunRequest.prompt`, system prompt, or ACP content blocks.

- [ ] **Step 2: Document ownership**

Document that Pi Providers configure Pi only; OpenCode/Codex/Claude/Cursor retain their own auth/provider configuration. Document default routing, fallback behavior, and safe install restrictions.

- [ ] **Step 3: Run targeted suites**

Run:

```bash
pnpm exec vitest run \
  packages/agent-registry/src/index.test.ts \
  packages/backends/src/agent-setup.test.ts \
  apps/bridge/src/session-api.test.ts \
  apps/web/src/lib/workbench-logic.test.ts \
  packages/backends/src/acp-prompt-turn.test.ts \
  packages/backends/src/pi-session-runner.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Run build and lint**

Run: `pnpm build && pnpm lint`

Expected: both commands exit 0.

- [ ] **Step 5: Run full tests**

Run: `pnpm test`

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/backends/src/acp-prompt-turn.test.ts packages/backends/src/pi-session-runner.test.ts docs/orchestration/agent-providers.md
git commit -m "test(agents): protect prompt stability during setup"
```
