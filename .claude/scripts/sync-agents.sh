#!/bin/bash
# sync-agents.sh - Sync agent definitions across Claude Code instances
# Usage: ./sync-agents.sh

set -e

CLAUDE_DIR="$HOME/.claude"
PROJECT_AGENTS_DIR="$(pwd)/.claude/agents"

echo "=== Agent Sync ==="
echo "Project agents: $PROJECT_AGENTS_DIR"
echo ""

# Check if we're in a git repo with agents
if [ ! -d "$PROJECT_AGENTS_DIR" ]; then
    echo "ERROR: No .claude/agents/ directory found in current directory"
    echo "Run this from your Continuous-Claude-v3 project directory"
    exit 1
fi

# Pull latest changes
echo "Pulling latest changes..."
git pull origin main 2>/dev/null || echo "  (no changes or not a git repo)"

# List available agents
echo ""
echo "Available agents (${#AGENT_FILES[@]}):"
ls -1 "$PROJECT_AGENTS_DIR"/*.md | xargs -I {} basename {} .md | head -20

echo ""
echo "To use agents in another terminal:"
echo "  1. cd /path/to/Continuous-Claude-v3"
echo "  2. git pull"
echo "  3. claude (restart or new session)"
