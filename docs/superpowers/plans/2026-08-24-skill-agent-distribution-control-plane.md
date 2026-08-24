# Skill Agent Distribution Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a production Skill catalog and per-Agent symlink distribution control plane in the Web workbench while keeping all local filesystem ownership in Runner Host.

**Architecture:** `SkillControlPlane` in `@codebridge/backends` scans and mutates local Skill sources and Agent target directories. Runner Host exposes the local contract, `RunnerClient` and Bridge proxy it without filesystem access, and a new Web first-class page renders catalog, assignment, reconciliation, and operation feedback from real API state.

**Tech Stack:** TypeScript, Node filesystem APIs, Hono, React, Tailwind CSS, Vitest, Testing Library.

---

## File structure

- Create `packages/backends/src/skill-control-plane.ts`: filesystem domain service, metadata parsing, source registry, target adapters, preview/apply safety.
- Create `packages/backends/src/skill-control-plane.test.ts`: temporary-directory filesystem tests.
- Modify `packages/backends/src/index.ts`: export the service and types.
- Modify `packages/runner-host/src/server.ts`: own the service and expose Runner-local routes.
- Modify `packages/runner-host/src/server.test.ts`: Runner route contract tests.
- Modify `packages/runner-client/src/index.ts`: typed Runner proxy methods.
- Modify `packages/runner-client/src/index.test.ts`: proxy request/response tests.
- Create `apps/bridge/src/skill-api.ts`: Bridge `/v1/skills/*` proxy only.
- Create `apps/bridge/src/skill-api.test.ts`: auth, validation, and error mapping tests.
- Modify `apps/bridge/src/outbound-api.ts`: mount the Skill API.
- Modify `apps/bridge/src/cli.ts`: construct and pass the Skill API.
- Modify `apps/web/src/lib/types.ts`: Web Skill API view types.
- Modify `apps/web/src/lib/api.ts`: Skill API client methods.
- Modify `apps/web/src/lib/api.test.ts`: request contract tests.
- Create `apps/web/src/components/skill-control-plane.tsx`: production Skill page.
- Create `apps/web/src/components/skill-control-plane.test.tsx`: active-surface interaction tests.
- Modify `apps/web/src/components/workbench-shared.ts`: add the `skills` first-class area.
- Modify `apps/web/src/components/session-chrome.tsx`: add the Rail entry.
- Modify `apps/web/src/components/workbench.tsx`: route the first-class area without a Session panel/header.
- Modify `apps/web/src/components/session-chrome.test.tsx`: navigation regression coverage.
- Modify `apps/web/src/components/workbench-component-policy.test.ts`: active production mount coverage.

### Task 1: Runner filesystem domain

- [ ] **Step 1: Write failing service tests**

Cover a shared root, an adopted single-Skill root, frontmatter fallback, real-path deduplication, `absent`, `linked`, `conflict`, `broken`, and `native` states with temporary HOME/data directories.

- [ ] **Step 2: Run the focused test and confirm failure**

Run: `pnpm vitest run packages/backends/src/skill-control-plane.test.ts`

Expected: FAIL because `SkillControlPlane` does not exist.

- [ ] **Step 3: Implement catalog scanning and source persistence**

Add the exact public surface:

```ts
export class SkillControlPlane {
  constructor(options: SkillControlPlaneOptions);
  scan(): SkillCatalogSnapshot;
  addSource(rawPath: string): SkillCatalogSnapshot;
  preview(input: SkillAssignmentInput): SkillAssignmentPreview;
  apply(input: SkillAssignmentInput): SkillAssignmentResult;
}
```

Use `JsonArrayStore<string>` for `<dataDir>/skill-sources.json`, SHA-256 for IDs/revisions, and Node filesystem functions only.

- [ ] **Step 4: Implement safe preview/apply**

Recompute state inside `apply`; create only missing target symlinks; unlink only a symlink that resolves to the requested Source; reject all conflicts with stable error codes.

- [ ] **Step 5: Run focused tests**

Run: `pnpm vitest run packages/backends/src/skill-control-plane.test.ts`

Expected: PASS.

### Task 2: Runner Host contract

- [ ] **Step 1: Run GitNexus impact for `RunnerHost` and `createRunnerApp`**

Run:

```bash
npx gitnexus impact -r CodeBridge --depth 3 --include-tests RunnerHost
npx gitnexus impact -r CodeBridge --depth 3 --include-tests createRunnerApp
```

Expected: review direct consumers before edits; stop and warn on HIGH/CRITICAL.

- [ ] **Step 2: Write failing Runner route tests**

Test authenticated `GET /skills`, `POST /skills/sources`, `POST /skills/assignments/preview`, and `POST /skills/assignments/apply`, plus malformed bodies and structured service errors.

- [ ] **Step 3: Add the injected/default Skill service and routes**

Extend `RunnerHostOptions` with an injectable service for tests, instantiate the production service with Runner `dataDir`, and keep all filesystem work behind host methods.

- [ ] **Step 4: Run Runner tests**

Run: `pnpm vitest run packages/runner-host/src/server.test.ts`

Expected: PASS.

### Task 3: RunnerClient and Bridge proxy

- [ ] **Step 1: Run GitNexus impact for `RunnerClient` and `createBridgeApp`**

Run:

```bash
npx gitnexus impact -r CodeBridge --depth 3 --include-tests RunnerClient
npx gitnexus impact -r CodeBridge --depth 3 --include-tests createBridgeApp
```

- [ ] **Step 2: Write failing RunnerClient and Bridge API tests**

Lock request methods, URL paths, snake-case JSON payloads, Bearer auth, Runner-unavailable mapping, and conflict status propagation.

- [ ] **Step 3: Add typed RunnerClient methods**

Add `listSkills`, `addSkillSource`, `previewSkillAssignment`, and `applySkillAssignment` using a shared request helper that preserves Runner error code/status.

- [ ] **Step 4: Implement and mount `createSkillApp`**

The Bridge app must validate request shape, call only `RunnerClient`, and return Runner responses unchanged except for a stable `runner_unavailable` 503.

- [ ] **Step 5: Run focused contract tests**

Run:

```bash
pnpm vitest run packages/runner-client/src/index.test.ts apps/bridge/src/skill-api.test.ts apps/bridge/src/outbound-api.test.ts
```

Expected: PASS.

### Task 4: Web API and Skill page

- [ ] **Step 1: Write failing Web API and active-surface tests**

Assert the page loads real catalog data, filters cards, switches four views, opens detail, previews before Apply, refreshes after Apply, renders conflict errors, and never writes desired state before a successful response.

- [ ] **Step 2: Add Web types and API methods**

Use the accepted snake-case response contract without recomputing target paths or projection state in the browser.

- [ ] **Step 3: Implement `SkillControlPlanePage`**

Match `docs/orchestration/DESIGN.md`: semantic tokens only, Chinese UI, 36px controls, no emoji, local matrix horizontal scrolling, bounded drawer, and `aria-label` on icon-only actions. The Add action uses the Runner directory picker through a dedicated Skill endpoint and only exposes local-directory adoption in V1.

- [ ] **Step 4: Run focused Web tests**

Run:

```bash
pnpm vitest run apps/web/src/lib/api.test.ts apps/web/src/components/skill-control-plane.test.tsx
```

Expected: PASS.

### Task 5: First-class navigation integration

- [ ] **Step 1: Re-run and report HIGH-risk `AgentRail` impact**

Run: `npx gitnexus impact -r CodeBridge --depth 3 --include-tests AgentRail`

Expected: Workbench and DesignPreview are direct consumers; both remain valid after the prop-compatible area extension.

- [ ] **Step 2: Write failing navigation tests**

Assert Agent, Flow, Skill, Settings order; `aria-pressed`; no Session panel/header for Skill; and the Skill page is mounted in the production Workbench branch.

- [ ] **Step 3: Add the `skills` area and mount the page**

Extend `PanelArea`, add a BookOpen-style Rail icon after Flow, keep the existing 60px Rail, and render Skill as a full-width primary page rather than Settings or Session content.

- [ ] **Step 4: Run navigation and component-policy tests**

Run:

```bash
pnpm vitest run apps/web/src/components/session-chrome.test.tsx apps/web/src/components/workbench-component-policy.test.ts
```

Expected: PASS.

### Task 6: End-to-end verification and delivery

- [ ] **Step 1: Run all focused tests and type checks**

Run:

```bash
pnpm vitest run packages/backends/src/skill-control-plane.test.ts packages/runner-host/src/server.test.ts packages/runner-client/src/index.test.ts apps/bridge/src/skill-api.test.ts apps/web/src/lib/api.test.ts apps/web/src/components/skill-control-plane.test.tsx apps/web/src/components/session-chrome.test.tsx apps/web/src/components/workbench-component-policy.test.ts
pnpm -r run build
pnpm lint
```

Expected: PASS with zero TypeScript or ESLint errors.

- [ ] **Step 2: Run filesystem adversarial tests**

Verify repeat Apply, ordinary-directory collision, foreign symlink, broken link, moved Source, invalid path, same-name Sources, and disable of native directories all fail safely or remain idempotent as specified.

- [ ] **Step 3: Run active Web surface QA**

Start the local stack, open `/workbench/`, select Skill, and verify 1440, 960, and 720 widths. Expected: no outer horizontal overflow; only the assignment matrix scrolls horizontally.

- [ ] **Step 4: Run GitNexus change detection before commit**

Run: `npx gitnexus detect-changes -r CodeBridge --scope all`

Expected: only Skill filesystem control, Runner/Bridge proxy, Web Skill surface, and first-class navigation are affected. Investigate any Flow/Session/Channel execution-flow impact before commit.

- [ ] **Step 5: Commit implementation**

Stage only files listed in this plan. Do not stage existing `AGENTS.md`, `.claude/`, `.playwright-cli/`, `.superpowers/`, generated Vite timestamps, `output/`, `test-results/`, or unrelated Flow documents.

Commit message: `feat(skills): add agent distribution control plane`
