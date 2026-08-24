import type { BackendProfile, DoctorResult } from "@codebridge/core";
import { detectBackend } from "./acp/acp-doctor.js";

export class BackendRegistry {
  private readonly profiles = new Map<string, BackendProfile>();

  register(id: string, profile: BackendProfile): void {
    this.profiles.set(id, profile);
  }

  getProfile(id: string): BackendProfile | undefined {
    return this.profiles.get(id);
  }

  ids(): string[] {
    return [...this.profiles.keys()];
  }

  async doctor(cwd: string): Promise<DoctorResult> {
    const all: DoctorResult["checks"] = [];
    let ok = true;
    for (const [id, profile] of this.profiles) {
      const result = await detectBackend(id, profile, cwd);
      all.push(...result.checks);
      if (!result.ok) ok = false;
    }
    return { ok, checks: all };
  }
}

export {
  resolveAcpSpawn,
  acpContinueMethod,
  runAcpSession,
  deleteAcpSession,
  loadAcpSessionHistory,
  listAcpConfigOptions,
  listAcpSessions,
  killProcessTree,
  mapSessionUpdate,
  AcpSessionPool,
  type AcpSessionPoolOptions,
} from "./acp/index.js";

export {
  type CliSessionSummary,
  type ProviderSessionHistoryEvent,
  collectCodexSessionHistory,
  encodeClaudeProjectDir,
  loadCodexSessionHistory,
  loadClaudeSessionHistory,
} from "./session-discovery.js";

export { testProviderConnection, type ProviderConnectionProbe } from "./provider-connection.js";
export { listCodexSkillCommands } from "./codex-skill-commands.js";

export {
  SKILL_AGENT_IDS,
  SkillControlPlane,
  SkillControlPlaneError,
  type SkillAgentId,
  type SkillCatalogEntry,
  type SkillCatalogSnapshot,
  type SkillControlPlaneErrorCode,
  type SkillControlPlaneOptions,
  type SkillDeliveryMode,
  type SkillGlobalState,
  type SkillMutationKind,
  type SkillMutationPlan,
  type SkillMutationResult,
  type SkillMutationStep,
  type SkillOwnership,
  type SkillProjectionState,
  type SkillSourceKind,
  type SkillTargetDefinition,
  type SkillTargetView,
} from "./skill-control-plane.js";

export {
  closePiSession,
  deletePiSession,
  forkPiSession,
  loadPiSessionHistory,
  listPiSessions,
  listPiConfigOptions,
  listPiCommands,
  mapPiEvent,
  probePiSdk,
  runPiSession,
  type PiRunHandle,
  type PiRunHandleRef,
  type PiSession,
  type PiSessionLifecycleResult,
  type PiSessionRunnerOptions,
} from "./pi-session-runner.js";

export {
  AgentSetupService,
  redactSetupOutput,
  type AgentCommandResult,
  type AgentSetupInstallResult,
  type AgentSetupRecord,
  type AgentSetupServiceOptions,
} from "./agent-setup.js";

export {
  PI_PROVIDER_PRESETS,
  piModelsPath,
  readPiProviders,
  validateProviders,
  writePiProviders,
  type PiProvider,
  type PiProviderModel,
  type PiProviderPreset,
  type PiProvidersFile,
} from "./pi-providers.js";
