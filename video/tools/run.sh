#!/bin/zsh
# run.sh <script.cjs> [args...]  — runs a node script with playwright from the pinned MCP package
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
cd "$(dirname "$0")"
npx -y --package=@playwright/mcp@0.0.82 -c "node $*"
