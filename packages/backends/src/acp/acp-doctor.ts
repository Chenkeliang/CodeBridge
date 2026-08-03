import type { BackendProfile, DoctorResult } from "@codebridge/core";
import { probeAcpInitialize } from "./acp-session-list.js";

export async function detectBackend(
  id: string,
  profile: BackendProfile,
  cwd: string,
): Promise<DoctorResult> {
  const acp = await probeAcpInitialize(profile, cwd);
  return {
    ok: acp.ok,
    checks: [
      {
        name: `${id}:acp-initialize`,
        ok: acp.ok,
        message: acp.message,
      },
    ],
  };
}
