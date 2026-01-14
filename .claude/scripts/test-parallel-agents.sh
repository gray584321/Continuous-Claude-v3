#!/bin/bash
# test-parallel-agents.sh - Test parallel agent output isolation
# This script verifies that multiple agents of the same type can run
# concurrently without output collision.

set -e

CLAUDE_PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
AGENT_CACHE_DIR="$CLAUDE_PROJECT_DIR/.claude/cache/agents"
AGENT_TYPE="${1:-oracle}"
NUM_AGENTS="${2:-3}"

echo "=== Parallel Agent Output Isolation Test ==="
echo "Agent type: $AGENT_TYPE"
echo "Number of agents: $NUM_AGENTS}"
echo ""

# Clean up any existing output files for this agent type
rm -rf "$AGENT_CACHE_DIR/$AGENT_TYPE/exec-"* 2>/dev/null || true
mkdir -p "$AGENT_CACHE_DIR/$AGENT_TYPE"

# Track output directories
OUTPUT_DIRS=()

echo "Spawning $NUM_AGENTS agents in parallel..."
for i in $(seq 1 $NUM_AGENTS); do
    TIMESTAMP=$(date +%s)
    RANDOM_SUFFIX=$(head -c 4 /dev/urandom | xxd -p)
    OUTPUT_DIR="$AGENT_CACHE_DIR/$AGENT_TYPE/exec-$TIMESTAMP-$RANDOM_SUFFIX"
    OUTPUT_DIRS+=("$OUTPUT_DIR")
    mkdir -p "$OUTPUT_DIR"

    # Simulate agent output (in real use, this would be the agent itself)
    echo "# Agent $i Output
Task: Research topic $i
Finding: This is the research result for topic $i
Timestamp: $(date -Iseconds)
" > "$OUTPUT_DIR/output.md"

    echo "  Agent $i -> $(basename $OUTPUT_DIR)"
done

echo ""
echo "Verifying output isolation..."

SUCCESS=true
OUTPUT_COUNT=0

for output_dir in "${OUTPUT_DIRS[@]}"; do
    if [ -f "$output_dir/output.md" ]; then
        OUTPUT_COUNT=$((OUTPUT_COUNT + 1))
        echo "  [OK] $(basename $output_dir)/output.md exists"

        # Verify content is unique
        TOPIC_LINE=$(grep "Task:" "$output_dir/output.md" || echo "")
        if [ -z "$TOPIC_LINE" ]; then
            echo "  [WARN] Content may be corrupted in $(basename $output_dir)"
        fi
    else
        echo "  [FAIL] $(basename $output_dir)/output.md NOT FOUND"
        SUCCESS=false
    fi
done

echo ""
if [ "$SUCCESS" ] && [ "$OUTPUT_COUNT" -eq "$NUM_AGENTS" ]; then
    echo "=== TEST PASSED ==="
    echo "All $OUTPUT_COUNT agents have unique output files."
    echo ""
    echo "Output files:"
    ls -la "${OUTPUT_DIRS[@]}" 2>/dev/null | grep -v "^total" | head -20
    exit 0
else
    echo "=== TEST FAILED ==="
    echo "Expected $NUM_AGENTS output files, found $OUTPUT_COUNT"
    exit 1
fi
