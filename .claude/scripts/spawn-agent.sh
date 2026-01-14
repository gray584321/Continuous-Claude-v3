#!/bin/bash
# spawn-agent.sh - Spawn an agent with a unique output directory
# Usage: ./spawn-agent.sh <agent-name> <task-prompt> [output-dir]
#
# This script ensures each agent execution gets a unique output directory
# to prevent output collision when multiple agents of the same type run in parallel.

set -e

AGENT_NAME="${1:-}"
TASK_PROMPT="${2:-}"
OUTPUT_DIR="${3:-}"

if [ -z "$AGENT_NAME" ] || [ -z "$TASK_PROMPT" ]; then
    echo "Usage: $0 <agent-name> <task-prompt> [output-dir]"
    echo ""
    echo "Arguments:"
    echo "  agent-name   Name of the agent to spawn (e.g., oracle, scout)"
    echo "  task-prompt  The task description for the agent"
    echo "  output-dir   Optional: custom output directory (auto-generated if not provided)"
    exit 1
fi

# Generate unique output directory if not provided
if [ -z "$OUTPUT_DIR" ]; then
    TIMESTAMP=$(date +%s)
    RANDOM_SUFFIX=$(head -c 4 /dev/urandom | xxd -p)
    OUTPUT_DIR="$CLAUDE_PROJECT_DIR/.claude/cache/agents/$AGENT_NAME/exec-$TIMESTAMP-$RANDOM_SUFFIX"
fi

# Create the output directory
mkdir -p "$OUTPUT_DIR"

echo "Spawning agent: $AGENT_NAME"
echo "Output directory: $OUTPUT_DIR"
echo ""

# Spawn the agent using claude Task tool with unique output directory
# The CLAUDE_OUTPUT_DIR environment variable tells the agent where to write
claude --agent "$AGENT_NAME" \
    --prompt "$TASK_PROMPT" \
    --env "CLAUDE_OUTPUT_DIR=$OUTPUT_DIR" \
    --output-dir "$OUTPUT_DIR"

echo ""
echo "Agent completed. Output written to: $OUTPUT_DIR/output.md"
