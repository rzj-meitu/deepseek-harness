#!/usr/bin/env bash
#
# 一键把桌面端切到 dsh 最新上游并重新打包。
#
#   全流程(更新 + 适配 manifest + 装依赖 + 构建 + 打包):
#     apps/desktop/scripts/repack.sh
#
#   只更新 + 适配 + 装依赖 + 构建, 不打包:
#     SKIP_PACKAGE=1 apps/desktop/scripts/repack.sh
#
#   只更新 + 适配 + 装依赖, 跳过 typecheck/build:
#     SKIP_CHECKS=1 apps/desktop/scripts/repack.sh
#
# rebase 时若只有 pnpm-lock.yaml 冲突, 脚本自动取上游版本并交给后面的
# `pnpm install` 重生成; 其它冲突会中止并提示手动处理。
#
# 沙箱(GUI/agent 环境)里打包需要额外环境变量, 见本文件末尾注释。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

BRANCH="${DESKTOP_BRANCH:-feat/electron-desktop}"
UPSTREAM="${UPSTREAM:-origin}"

command -v node >/dev/null 2>&1 || { echo "!! 找不到 node, 请先把它加进 PATH" >&2; exit 1; }
command -v pnpm >/dev/null 2>&1 || { echo "!! 找不到 pnpm, 请先把它加进 PATH" >&2; exit 1; }

if [ -n "$(git status --porcelain)" ]; then
  echo "!! 工作区不干净, 请先提交或暂存改动:" >&2
  git status --short >&2
  exit 1
fi

echo "==> 拉取上游 ($UPSTREAM)..."
git fetch "$UPSTREAM" --tags --prune

echo "==> 快进本地 master..."
git switch master
git merge --ff-only "$UPSTREAM/master"

echo "==> rebase $BRANCH 到 $UPSTREAM/master..."
git switch "$BRANCH"
if ! git rebase "$UPSTREAM/master"; then
  while [ -n "$(git diff --name-only --diff-filter=U)" ]; do
    CONFLICTS="$(git diff --name-only --diff-filter=U)"
    NON_LOCK="$(printf '%s\n' "$CONFLICTS" | grep -v '^pnpm-lock.yaml$' || true)"
    if [ -n "$NON_LOCK" ]; then
      echo "!! 非 lockfile 冲突, 需手动处理:" >&2
      printf '%s\n' "$NON_LOCK" | sed 's/^/   /' >&2
      git rebase --abort
      exit 1
    fi
    # lockfile 冲突一律取上游, 稍后 pnpm install 重生成
    git checkout --ours pnpm-lock.yaml
    git add pnpm-lock.yaml
    GIT_EDITOR=true git rebase --continue || true
  done
fi

echo "==> 重算运行时 manifest 种子..."
node apps/desktop/scripts/refresh-runtime-manifest.mjs

echo "==> 重新安装依赖(重生成 lockfile)..."
pnpm install

if [ "${SKIP_CHECKS:-0}" = "1" ]; then
  echo "==> SKIP_CHECKS=1, 跳过 typecheck/build"
else
  echo "==> typecheck..."
  pnpm run typecheck
  echo "==> build..."
  pnpm run build
fi

if [ "${SKIP_PACKAGE:-0}" = "1" ]; then
  echo "==> SKIP_PACKAGE=1, 跳过打包"
else
  echo "==> 打包桌面端..."
  (cd apps/desktop && pnpm run dist:mac)
fi

echo "==> 完成"

# 沙箱(GUI/agent 环境)打包注意事项:
#   1. 先 export PATH="/usr/local/bin:$PATH" 让 node/pnpm 可见。
#   2. electron-builder 缓存写不到 ~/Library/Caches, 且 apps/desktop 是
#      "type": "module" 会让缓存里的 CJS 工具被当 ESM 跑崩, 所以把缓存指到
#      临时目录:
#         ELECTRON_BUILDER_CACHE="$TMPDIR/electron-builder-cache" \
#           apps/desktop/scripts/repack.sh
#   3. 签名: codesign 在沙箱里访问不了钥匙串, 用 CSC_IDENTITY_AUTO_DISCOVERY=false
#      跳过签名(仅本地自测用)。
#   4. DMG 的 hdiutil 需要更宽权限, 需用 danger-full-access 提权单独跑
#      electron-builder 的 dmg 步骤。
#   在你自己的终端里以上几点都不存在, 直接跑 apps/desktop/scripts/repack.sh 即可。
