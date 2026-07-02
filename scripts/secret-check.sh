#!/usr/bin/env bash
# Push 前敏感信息自检
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'
fail=0

echo "==> 扫描已提交文件…"

# 不应出现在仓库里的文件名
while IFS= read -r f; do
  echo -e "${RED}FAIL${NC}: 不应提交 $f"
  fail=1
done < <(git ls-files | rg -x '\.env|deploy/\.env|chat-bindings\.json|sessions\.json' || true)

if [[ "$fail" -eq 0 ]]; then
  echo -e "${GREEN}OK${NC}: 无 .env / chat-bindings 等运行时文件"
fi

# YAML / env 示例中的真实凭据形态
scan_yaml() {
  local name="$1"
  local pattern="$2"
  if git grep -nE "$pattern" HEAD -- '*.yaml' '*.yml' '.env.example' 2>/dev/null; then
    echo -e "${RED}FAIL${NC}: $name"
    fail=1
  else
    echo -e "${GREEN}OK${NC}: $name"
  fi
}

scan_yaml "飞书 appSecret 实值" 'appSecret:\s+(?!(\$\{|secret_placeholder|xxx))[^#\s]{8,}'
scan_yaml "飞书 appId 实值" 'appId:\s+cli_[a-z0-9]{8,}'
scan_yaml "Runner token 实值" 'token:\s+(?!change-me)(\S{24,})'

if git grep -nE 'gh[op]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}' HEAD 2>/dev/null; then
  echo -e "${RED}FAIL${NC}: 发现 API token"
  fail=1
else
  echo -e "${GREEN}OK${NC}: 无 gh/sk token"
fi

if git grep -n '/Users/[^/]+/' HEAD -- '*.test.ts' 2>/dev/null; then
  echo -e "${RED}FAIL${NC}: 测试文件含本机绝对路径"
  fail=1
else
  echo -e "${GREEN}OK${NC}: 测试无本机路径"
fi

if [[ "$fail" -ne 0 ]]; then
  echo ""
  echo "请先移除敏感内容再 push。"
  exit 1
fi

echo ""
echo "敏感信息检查通过。"
