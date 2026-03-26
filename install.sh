#!/usr/bin/env bash
set -euo pipefail

REPO_SLUG="${REPO_SLUG:-zhangshihai1232/acp-handoff}"
REPO_REF="${REPO_REF:-main}"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
EXTENSIONS_DIR="${OPENCLAW_HOME}/extensions"
TARGET_DIR="${EXTENSIONS_DIR}/acp-handoff"
ARCHIVE_URL="${ARCHIVE_URL:-https://codeload.github.com/${REPO_SLUG}/tar.gz/refs/heads/${REPO_REF}}"

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'Missing required command: %s\n' "$1" >&2
    exit 1
  fi
}

for cmd in bash curl tar mktemp find; do
  require_command "$cmd"
done

tmp_root="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_root"
}
trap cleanup EXIT

archive_file="${tmp_root}/acp-handoff.tar.gz"

printf '==> Downloading %s (%s)\n' "$REPO_SLUG" "$REPO_REF"
curl -fsSL "$ARCHIVE_URL" -o "$archive_file"

printf '==> Extracting archive\n'
tar -xzf "$archive_file" -C "$tmp_root"

source_dir="$(find "$tmp_root" -mindepth 1 -maxdepth 1 -type d -name 'acp-handoff-*' | head -n 1)"
if [ -z "$source_dir" ]; then
  printf 'Unable to locate extracted plugin directory.\n' >&2
  exit 1
fi

mkdir -p "$EXTENSIONS_DIR"

if [ -e "$TARGET_DIR" ]; then
  backup_dir="${TARGET_DIR}.backup-$(date +%Y%m%d-%H%M%S)"
  printf '==> Existing installation found, backing up to %s\n' "$backup_dir"
  mv "$TARGET_DIR" "$backup_dir"
fi

printf '==> Installing to %s\n' "$TARGET_DIR"
mv "$source_dir" "$TARGET_DIR"

if [ ! -f "$TARGET_DIR/openclaw.plugin.json" ]; then
  printf 'Installation failed: openclaw.plugin.json not found in %s\n' "$TARGET_DIR" >&2
  exit 1
fi

printf '\nInstalled acp-handoff successfully.\n'
printf 'Location: %s\n' "$TARGET_DIR"
printf 'Next step: open your OpenClaw environment and use the bundled skills under %s/skills\n' "$TARGET_DIR"
