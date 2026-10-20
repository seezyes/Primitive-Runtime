#!/usr/bin/env bash
set -euo pipefail
base="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
upstream="$base/upstream"
modified="$base/modified"
output="$base/patches/jcode-modifications.patch"
test -f "$upstream/Cargo.toml" && test -f "$modified/Cargo.toml" || { echo "Missing upstream or modified source" >&2; exit 1; }
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git -C "$tmp" init -q
cp -a "$upstream/." "$tmp/"
git -C "$tmp" add -A
git -C "$tmp" -c user.name=patch-generator -c user.email=patch-generator@localhost commit -qm baseline --allow-empty
# Copy working tree including deletions, but not temp Git metadata.
rsync -a --delete --exclude='.git/' "$modified/" "$tmp/"
mkdir -p "$base/patches"
git -C "$tmp" add -N .
git -C "$tmp" diff --binary HEAD -- . > "$output"
echo "Wrote $output ($(wc -c < "$output") bytes)"
