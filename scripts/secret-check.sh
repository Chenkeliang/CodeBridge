#!/usr/bin/env bash
# Fail closed; secret values are always redacted by the upstream scanner.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
scanner="${GITLEAKS_BIN:-gitleaks}"
if ! command -v "$scanner" >/dev/null 2>&1; then
  echo "Missing gitleaks: brew install gitleaks (or set GITLEAKS_BIN to the official binary)." >&2
  exit 2
fi
version="$("$scanner" version)"
IFS=. read -r scan_major scan_minor _ <<< "$version"
if ! [[ "$scan_major" =~ ^[0-9]+$ && "$scan_minor" =~ ^[0-9]+$ ]] || (( scan_major < 8 || (scan_major == 8 && scan_minor < 25) )); then
  echo "Gitleaks >= 8.25 is required for rule-scoped allowlists; update the official binary." >&2
  exit 2
fi
fail=0
while IFS= read -r -d '' file; do
  case "$file" in
    .env.example|*/.env.example) continue ;;
    .env|.env.*|*/.env|*/.env.*|backups/*|*/backups/*|config.yaml|*/config.yaml|publisher-tokens.json|*/publisher-tokens.json|*.bak|*.bak-*|*.bak.*|*.before-*|*.backup|chat-bindings.json|*/chat-bindings.json|sessions.json|*/sessions.json|workspaces.json|*/workspaces.json|feishu-alert-monitor.json|*/feishu-alert-monitor.json|managed-local-tasks.json|*/managed-local-tasks.json|management-audit.jsonl|*/management-audit.jsonl|management-backups/*|*/management-backups/*)
      echo "Forbidden runtime/backup file: $file" >&2; fail=1 ;;
  esac
  if [[ -n "${HOME:-}" && "$HOME" != "/" ]] && LC_ALL=C grep -qF -- "$HOME/" "$file" 2>/dev/null; then
    echo "Personal home path in tracked source: $file" >&2; fail=1
  fi
done < <(git ls-files --cached --others --exclude-standard -z)
if [[ "$fail" -ne 0 ]]; then exit 1; fi
"$scanner" git --redact=100 --no-banner --config .gitleaks.toml --log-opts=--all .
"$scanner" dir --redact=100 --no-banner --config .gitleaks.toml .
