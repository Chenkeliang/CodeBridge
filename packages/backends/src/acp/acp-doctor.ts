import type { BackendProfile, DoctorResult } from "@codebridge/core";
import { probeAcpInitialize } from "./acp-session-list.js";
import { probePiSdk } from "../pi-session-runner.js";

export async function detectBackend(
  id: string,
  profile: BackendProfile,
  cwd: string,
): Promise<DoctorResult> {
  const acp = profile.type === "pi-sdk"
    ? await probePiSdk(cwd)
    : await probeAcpInitialize(profile, cwd);
  return {
    ok: acp.ok,
    checks: [
      {
        name: `${id}:${profile.type === "pi-sdk" ? "sdk" : "acp-initialize"}`,
        ok: acp.ok,
        message: acp.message,
      },
    ],
  };
}
