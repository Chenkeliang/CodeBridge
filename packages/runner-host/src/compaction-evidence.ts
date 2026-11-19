import fs from "node:fs";
import path from "node:path";
import type { BackendProfile } from "@codebridge/core";
import { compactionDigest } from "./compaction-receipts.js";

export const COMMAND_PROTOCOL = 2;

interface CompactionEvidence {
  protocol: number;
  piSdk: true;
  codexProfiles: Record<string, string>;
  claudeProfiles?: Record<string, string>;
}

export function codexCompactionFingerprint(profile: BackendProfile): string {
  const files = [profile.acpCommand, ...(profile.acpArgs ?? [])]
    .filter((value): value is string => Boolean(value && path.isAbsolute(value) && /\.[cm]?js$/.test(value)));
  return compactionDigest([profile.acpCommand, profile.acpArgs, files.map((file) => compactionDigest(fs.readFileSync(file).toString("base64")))]);
}

export function readCommandEvidence(value?: string): CompactionEvidence | undefined {
  try {
    const evidence = JSON.parse(value ?? "null") as CompactionEvidence | null;
    if (!evidence || evidence.protocol !== COMMAND_PROTOCOL || evidence.piSdk !== true
      || !evidence.codexProfiles || Array.isArray(evidence.codexProfiles) || typeof evidence.codexProfiles !== "object"
      || !Object.values(evidence.codexProfiles).every((hash) => typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))
      || (evidence.claudeProfiles !== undefined && (!evidence.claudeProfiles || Array.isArray(evidence.claudeProfiles)
        || typeof evidence.claudeProfiles !== "object" || !Object.values(evidence.claudeProfiles).every((hash) =>
          typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash))))) return undefined;
    return evidence;
  } catch {
    return undefined;
  }
}
