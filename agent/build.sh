#!/usr/bin/env bash
# Builds the Windows agent reproducibly and records its version and SHA-256 for the API.
# Same Go version + same source = same file, so anyone can check the published exe matches this source.
set -euo pipefail
cd "$(dirname "$0")"
VERSION=$(sed -n 's/^const AgentVersion = "\(.*\)"/\1/p' main.go)
OUT=../api/assets/agent/nexpatch-agent.exe
mkdir -p "$(dirname "$OUT")"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 go build -trimpath -ldflags "-s -w -buildid=" -o "$OUT" .
SHA=$(sha256sum "$OUT" | cut -d' ' -f1)
SIZE=$(stat -c %s "$OUT")
cat > ../api/src/lib/agentrelease.js <<JS
// Written by agent/build.sh. Do not edit by hand: rebuild the agent instead.
export const AGENT_RELEASE = Object.freeze({ version: '$VERSION', sha256: '$SHA', size: $SIZE, goVersion: '$(go env GOVERSION)', file: 'nexpatch-agent.exe' });
JS
echo "Built $OUT $VERSION $SHA"
