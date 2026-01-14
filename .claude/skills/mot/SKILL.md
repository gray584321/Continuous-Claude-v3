---
name: mot
description: System health check (MOT) for skills, agents, hooks, memory, Docker, and embeddings
model: sonnet
allowed-tools: [Read, Bash, Glob, Grep]
---

# MOT - System Health Check

Run comprehensive health checks on all Claude Code components including Docker services, embeddings, memory system, hooks, agents, skills, and tldr.

## Usage

```
/mot              # Full audit (all categories)
/mot docker       # Just Docker services (PostgreSQL, Redis)
/mot embeddings   # Just embeddings and memory
/mot hooks        # Just hooks
/mot agents       # Just agents
/mot skills       # Just skills
/mot memory       # Just memory system
/mot tldr         # Just tldr and tools
/mot --fix        # Auto-fix simple issues
/mot --quick      # P0 checks only (fast)
/mot --comprehensive # Full validation (2-3 min)
```

## Audit Process

### Define paths (user-level first, project-level override)
```bash
USER_CLAUDE="$HOME/.claude"
PROJECT_CLAUDE="${CLAUDE_PROJECT_DIR:-.}/.claude"

# Build arrays for skills and agents (user + optional project)
SKILL_DIRS=("$USER_CLAUDE/skills")
[ -d "$PROJECT_CLAUDE/skills" ] && SKILL_DIRS+=("$PROJECT_CLAUDE/skills")

AGENT_DIRS=("$USER_CLAUDE/agents")
[ -d "$PROJECT_CLAUDE/agents" ] && AGENT_DIRS+=("$PROJECT_CLAUDE/agents")

HOOKS_DIR="$USER_CLAUDE/hooks"
```

### Phase 1: Docker Services (P0 Critical)

**PostgreSQL Service:**
```bash
echo "=== DOCKER SERVICES ==="
echo "=== PostgreSQL ==="

# Container health
if docker ps | grep -q postgres; then
  echo "✓ PostgreSQL container running"
else
  echo "✗ PostgreSQL container not running"
fi

# Connection test
if psql "$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1; then
  echo "✓ PostgreSQL connected"
else
  echo "✗ PostgreSQL connection failed"
fi

# Schema validation
TABLES=$(psql "$DATABASE_URL" -c "\dt" 2>/dev/null | grep -E "(sessions|file_claims|archival_memory|handoffs)" | wc -l)
if [ "$TABLES" -ge 3 ]; then
  echo "✓ Core tables exist ($TABLES tables found)"
else
  echo "✗ Missing tables (only $TABLES found)"
fi

# Extensions
if psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname='vector'" 2>/dev/null | grep -q vector; then
  echo "✓ pgvector extension installed"
else
  echo "✗ pgvector extension not installed"
fi

# Performance test
START=$(date +%s%3N)
psql "$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1
END=$(date +%s%3N)
LATENCY=$((END - START))
if [ "$LATENCY" -lt 100 ]; then
  echo "✓ Query latency: ${LATENCY}ms (good)"
elif [ "$LATENCY" -lt 500 ]; then
  echo "⚠ Query latency: ${LATENCY}ms (acceptable)"
else
  echo "✗ Query latency: ${LATENCY}ms (slow)"
fi
```

**Redis Service:**
```bash
echo "=== Redis ==="

# Container health
if docker ps | grep -q redis; then
  echo "✓ Redis container running"
else
  echo "✗ Redis container not running"
fi

# Connection test
if docker exec opc-redis redis-cli ping 2>/dev/null | grep -q PONG; then
  echo "✓ Redis connected"
else
  echo "✗ Redis connection failed"
fi

# Memory check
MEMORY=$(docker exec opc-redis redis-cli info memory 2>/dev/null | grep used_memory_human | cut -d: -f2 | tr -d '\r')
echo "Memory usage: $MEMORY"

# Pub/Sub test
if docker exec opc-redis redis-cli PUBLISH test "hello" > /dev/null 2>&1; then
  echo "✓ Pub/Sub working"
else
  echo "✗ Pub/Sub failed"
fi
```

### Phase 2: Embeddings & Memory System (P0 Critical)

**Model Validation:**
```bash
echo "=== EMBEDDINGS & MEMORY ==="

# Check if we're in opc directory or have user scripts
if [ -d "opc" ]; then
  OPC_DIR="opc"
elif [ -d "$USER_CLAUDE/scripts/core" ]; then
  OPC_DIR="$USER_CLAUDE/scripts/core"
else
  echo "⚠ No opc directory found, skipping embedding tests"
  OPC_DIR=""
fi

if [ -n "$OPC_DIR" ]; then
  # Test embedding generation
  echo "Testing embedding model..."
  if (cd "$OPC_DIR" && uv run python -c "
from scripts.core.db.embedding_service import LocalEmbeddingProvider
import asyncio
p = LocalEmbeddingProvider('Qwen/Qwen3-Embedding-0.6B')
emb = asyncio.run(p.embed('test'))
assert len(emb) == 1024, f'Expected 1024 dims, got {len(emb)}'
print('✓ Embedding model OK (1024 dims)')
" 2>/dev/null); then
    echo "✓ Embedding model working"
  else
    echo "✗ Embedding model failed"
  fi

  # Test vector search
  echo "Testing vector search..."
  if (cd "$OPC_DIR" && uv run python -c "
from scripts.core.db.memory_factory import get_memory_backend
import asyncio
mb = get_memory_backend()
result = asyncio.run(mb.semantic_search('test query', limit=5))
print(f'✓ Vector search OK ({len(result)} results)')
" 2>/dev/null); then
    echo "✓ Vector search working"
  else
    echo "✗ Vector search failed"
  fi

  # Test recall script
  echo "Testing recall script..."
  if (cd "$OPC_DIR" && uv run python scripts/core/recall_learnings.py --query "test" --k 3 --json > /dev/null 2>&1); then
    echo "✓ Recall script works"
  else
    echo "✗ Recall script failed"
  fi

  # Test store script
  echo "Testing store script..."
  if (cd "$OPC_DIR" && uv run python scripts/core/store_learning.py --session-id "test" --type WORKING_SOLUTION --content "Test learning" --context "testing" --tags "test" --confidence high > /dev/null 2>&1); then
    echo "✓ Store script works"
  else
    echo "✗ Store script failed"
  fi
fi
```

### Phase 3: Skills Audit
```bash
# Count skills
echo "=== SKILLS ==="
SKILL_COUNT=$(find "${SKILL_DIRS[@]}" -name "SKILL.md" 2>/dev/null | wc -l | xargs)
echo "Found $SKILL_COUNT skill files"

# Check frontmatter parsing
FAIL=0
for skill in $(find "${SKILL_DIRS[@]}" -name "SKILL.md" 2>/dev/null); do
  if ! head -1 "$skill" | grep -q "^---$"; then
    echo "FAIL: No frontmatter: $skill"
    FAIL=$((FAIL+1))
  fi
done
echo "Frontmatter: $((SKILL_COUNT - FAIL)) pass, $FAIL fail"

# Check name matches directory
FAIL=0
for skill in $(find "${SKILL_DIRS[@]}" -name "SKILL.md" 2>/dev/null); do
  dir=$(basename $(dirname "$skill"))
  name=$(grep "^name:" "$skill" 2>/dev/null | head -1 | cut -d: -f2 | xargs)
  if [ -n "$name" ] && [ "$dir" != "$name" ]; then
    echo "FAIL: Name mismatch $dir vs $name"
    FAIL=$((FAIL+1))
  fi
done
echo "Name consistency: $((SKILL_COUNT - FAIL)) pass, $FAIL fail"
```

### Phase 2: Agents Audit
```bash
echo "=== AGENTS ==="
AGENT_COUNT=$(ls "${AGENT_DIRS[@]}"/*.md 2>/dev/null | wc -l | xargs)
echo "Found $AGENT_COUNT agent files"

# Check required fields
FAIL=0
for agent in "${AGENT_DIRS[@]}"/*.md; do
  [ -f "$agent" ] || continue

  # Check name field exists
  if ! grep -q "^name:" "$agent"; then
    echo "FAIL: Missing name: $agent"
    FAIL=$((FAIL+1))
    continue
  fi

  # Check model is valid
  model=$(grep "^model:" "$agent" | head -1 | cut -d: -f2 | xargs)
  case "$model" in
    opus|sonnet|haiku) ;;
    *) echo "FAIL: Invalid model '$model': $agent"; FAIL=$((FAIL+1)) ;;
  esac
done
echo "Agent validation: $((AGENT_COUNT - FAIL)) pass, $FAIL fail"

# Check for dangling references (agents that reference non-existent agents)
echo "Checking agent cross-references..."
for agent in "${AGENT_DIRS[@]}"/*.md; do
  [ -f "$agent" ] || continue
  # Find subagent_type references
  refs=$(grep -oE 'subagent_type[=:]["'\'']*([a-z-]+)' "$agent" 2>/dev/null | sed 's/.*["'\'']//' | sed 's/["'\'']$//')
  for ref in $refs; do
    if [ ! -f "$USER_CLAUDE/agents/$ref.md" ] && [ ! -f "$PROJECT_CLAUDE/agents/$ref.md" ]; then
      echo "WARN: $agent references non-existent agent: $ref"
    fi
  done
done
```

### Phase 3: Hooks Audit
```bash
echo "=== HOOKS ==="

# Check TypeScript source count
TS_COUNT=$(ls "$HOOKS_DIR/src"/*.ts 2>/dev/null | wc -l | xargs)
echo "Found $TS_COUNT TypeScript source files"

# Check bundles exist
BUNDLE_COUNT=$(ls "$HOOKS_DIR/dist"/*.mjs 2>/dev/null | wc -l | xargs)
echo "Found $BUNDLE_COUNT built bundles"

# Check shell wrappers are executable
FAIL=0
for sh in "$HOOKS_DIR"/*.sh; do
  [ -f "$sh" ] || continue
  if [ ! -x "$sh" ]; then
    echo "FAIL: Not executable: $sh"
    FAIL=$((FAIL+1))
  fi
done
SH_COUNT=$(ls "$HOOKS_DIR"/*.sh 2>/dev/null | wc -l | xargs)
echo "Shell wrappers: $((SH_COUNT - FAIL)) executable, $FAIL need chmod +x"

# Check hooks registered in settings.json exist
echo "Checking registered hooks..."
FAIL=0
# Use user's settings.json, fall back to project if exists
SETTINGS_PATH="$HOME/.claude/settings.json"
[ -f ".claude/settings.json" ] && SETTINGS_PATH=".claude/settings.json"
grep -oE '"command":\s*"[^"]*\.sh"' "$SETTINGS_PATH" 2>/dev/null | \
  sed 's/.*"\([^"]*\.sh\)".*/\1/' | \
  sed "s|\$HOME|$HOME|g" | \
  sort -u | while read hook; do
    # Resolve to actual path
    if [ ! -f "$hook" ]; then
      echo "WARN: Registered hook not found: $hook"
    fi
  done

# Hook execution tests
echo "Testing hook execution..."
if [ -f "$HOOKS_DIR/pre-tool-use-broadcast.mjs" ]; then
  # Test MJS hook
  if echo '{"timestamp": "'$(date -Iseconds)'", "tool": "Read", "input": {"file_path": "/tmp/test.txt"}}' | \
     node "$HOOKS_DIR/pre-tool-use-broadcast.mjs" > /dev/null 2>&1; then
    echo "✓ MJS hooks executable"
  else
    echo "⚠ MJS hook execution test failed (may be OK if input format changed)"
  fi
fi

# Test Python hook launcher
if [ -f "$HOOKS_DIR/hook_launcher.py" ]; then
  if python3 "$HOOKS_DIR/hook_launcher.py" session-symbol-index > /dev/null 2>&1; then
    echo "✓ Python launcher works"
  else
    echo "⚠ Python launcher test failed"
  fi
fi
```

### Phase 4: TLDR Universal Access (P1 High)

```bash
echo "=== TLDR ==="

# Check symlink
if [ -L "/usr/local/bin/tldr" ]; then
  echo "✓ TLDR symlink exists"
  TARGET=$(readlink -f /usr/local/bin/tldr)
  echo "  → $TARGET"
else
  echo "✗ TLDR symlink missing"
fi

# Check version
if tldr --version > /dev/null 2>&1; then
  VERSION=$(tldr --version 2>&1)
  echo "✓ TLDR version: $VERSION"
else
  echo "✗ TLDR not working"
fi

# Universal access test from /tmp
cd /tmp
if tldr structure . --lang python > /dev/null 2>&1; then
  echo "✓ Works from /tmp"
else
  echo "✗ Failed from /tmp"
fi

# From home
cd ~
if tldr tree . > /dev/null 2>&1; then
  echo "✓ Works from ~"
else
  echo "✗ Failed from ~"
fi

# From deep nested path
mkdir -p /tmp/deep/nested/test 2>/dev/null
cd /tmp/deep/nested/test
if tldr structure . --lang python > /dev/null 2>&1; then
  echo "✓ Works from nested path"
else
  echo "✗ Failed from nested path"
fi

# Cross-directory analysis (if in opc directory)
if [ -d "opc" ]; then
  cd /tmp
  if tldr context main --project opc --depth 1 > /dev/null 2>&1; then
    echo "✓ Cross-directory analysis works"
  else
    echo "✗ Cross-directory analysis failed"
  fi

  # Cache warm test
  cd opc
  if tldr warm . > /dev/null 2>&1; then
    echo "✓ Cache warm OK"
  else
    echo "⚠ Cache warm failed"
  fi
fi
```

### Phase 5: Settings & Configuration (P2 Medium)

```bash
echo "=== SETTINGS ==="

# Validate settings.json syntax
if python3 -c "import json; json.load(open('$HOME/.claude/settings.json'))" 2>/dev/null; then
  echo "✓ settings.json valid JSON"
else
  echo "✗ settings.json invalid"
fi

# Check required sections
if grep -q '"hooks"' ~/.claude/settings.json 2>/dev/null; then
  echo "✓ Hooks configured"
else
  echo "✗ No hooks in settings"
fi

if grep -q '"env"' ~/.claude/settings.json 2>/dev/null; then
  echo "✓ Environment configured"
else
  echo "⚠ No environment in settings"
fi

# Validate paths in settings
grep -oE '\$HOME[^"]*' ~/.claude/settings.json 2>/dev/null | while read path; do
  expanded=$(eval echo $path)
  if [ -e "$expanded" ]; then
    echo "✓ $path exists"
  else
    echo "✗ $path missing"
  fi
done
```

### Phase 6: Memory Audit
```bash
echo "=== MEMORY SYSTEM (LEGACY) ==="

# Check DATABASE_URL
if [ -z "$DATABASE_URL" ]; then
  echo "FAIL: DATABASE_URL not set"
else
  echo "PASS: DATABASE_URL is set"

  # Test connection
  if psql "$DATABASE_URL" -c "SELECT 1" > /dev/null 2>&1; then
    echo "PASS: PostgreSQL reachable"

    # Check pgvector
    if psql "$DATABASE_URL" -c "SELECT extname FROM pg_extension WHERE extname='vector'" 2>/dev/null | grep -q vector; then
      echo "PASS: pgvector extension installed"
    else
      echo "FAIL: pgvector extension not installed"
    fi

    # Check table exists
    if psql "$DATABASE_URL" -c "\d archival_memory" > /dev/null 2>&1; then
      echo "PASS: archival_memory table exists"

      # Count learnings
      COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM archival_memory" 2>/dev/null | xargs)
      echo "INFO: $COUNT learnings stored"
    else
      echo "FAIL: archival_memory table missing"
    fi
  else
    echo "FAIL: PostgreSQL not reachable"
  fi
fi

# Check Python dependencies
echo "Checking Python dependencies..."
# Check user-level scripts first, then fall back to opc/
if [ -f "$USER_CLAUDE/scripts/core/recall_learnings.py" ]; then
    (cd "$USER_CLAUDE/scripts/core" && uv run python -c "import psycopg2; import pgvector; import sentence_transformers" 2>/dev/null) && \
      echo "PASS: Python dependencies available" || \
      echo "WARN: Some Python dependencies missing"
elif [ -d "opc" ]; then
    (cd opc && uv run python -c "import psycopg2; import pgvector; import sentence_transformers" 2>/dev/null) && \
      echo "PASS: Python dependencies available" || \
      echo "WARN: Some Python dependencies missing"
else
    echo "WARN: No memory scripts found (opc/ or ~/.claude/scripts/core/)"
fi
```

### Phase 7: Cross-Reference Audit
```bash
echo "=== CROSS-REFERENCES ==="

# Check skills reference valid agents
echo "Checking skill → agent references..."
FAIL=0
for skill in $(find "${SKILL_DIRS[@]}" -name "SKILL.md" 2>/dev/null); do
  refs=$(grep -oE 'subagent_type[=:]["'\'']*([a-z-]+)' "$skill" 2>/dev/null | sed 's/.*["'\'']//' | sed 's/["'\'']$//')
  for ref in $refs; do
    if [ -n "$ref" ] && [ ! -f "$USER_CLAUDE/agents/$ref.md" ] && [ ! -f "$PROJECT_CLAUDE/agents/$ref.md" ]; then
      echo "FAIL: $skill references missing agent: $ref"
      FAIL=$((FAIL+1))
    fi
  done
done
echo "Skill→Agent refs: $FAIL broken"
```

## Auto-Fix (--fix flag)

If `--fix` is specified, automatically fix:

1. **Start Docker services**
   ```bash
   # Start PostgreSQL
   if [ -f "opc/docker-compose.yml" ]; then
     (cd opc && docker compose up -d postgres)
   fi

   # Start Redis
   if [ -f "opc/docker-compose.yml" ]; then
     (cd opc && docker compose up -d redis)
   fi
   ```

2. **Install pgvector extension**
   ```bash
   if [ -n "$DATABASE_URL" ]; then
     psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;" 2>/dev/null
   fi
   ```

3. **Make shell wrappers executable**
   ```bash
   chmod +x "$USER_CLAUDE/hooks"/*.sh 2>/dev/null
   chmod +x "$PROJECT_CLAUDE/hooks"/*.sh 2>/dev/null
   ```

4. **Rebuild hooks if TypeScript newer than bundles**
   ```bash
   cd "$USER_CLAUDE/hooks" && npm run build 2>/dev/null
   ```

5. **Create missing cache directories**
   ```bash
   mkdir -p "$USER_CLAUDE/cache/agents/{scout,kraken,oracle,spark}"
   mkdir -p "$USER_CLAUDE/cache/mot"
   mkdir -p "$USER_CLAUDE/cache/tldr"
   ```

6. **Install/fix TLDR symlink**
   ```bash
   if [ -f "$HOME/.venv/bin/tldr" ] && [ ! -L "/usr/local/bin/tldr" ]; then
     sudo ln -sf "$HOME/.venv/bin/tldr" /usr/local/bin/tldr
   fi
   ```

## Output Format

Write full report to `.claude/cache/mot/report-{timestamp}.md`:

```markdown
# MOT Health Report
Generated: {timestamp}

## Summary
| Category | Pass | Fail | Warn |
|----------|------|------|------|
| Docker   | 8    | 0    | 0    |
| Embeddings| 4   | 0    | 0    |
| Skills   | 204  | 2    | 0    |
| Agents   | 47   | 1    | 3    |
| Hooks    | 58   | 2    | 1    |
| TLDR     | 6    | 0    | 0    |
| Settings | 5    | 0    | 0    |
| Memory   | 4    | 0    | 1    |
| X-Refs   | 0    | 0    | 2    |

## Performance Metrics
- PostgreSQL: {latency}ms query time
- Redis: {memory} memory usage
- Embedding: {time}s model load
- TLDR: {time}s analysis

## Issues Found

### P0 - Critical
- [FAIL] PostgreSQL container not running
- [FAIL] Redis container not running
- [FAIL] pgvector extension missing

### P1 - High
- [FAIL] Embedding model failed to load
- [FAIL] Agent references missing: scot → scout (typo)

### P2 - Medium
- [WARN] 3 hooks need rebuild (dist older than src)
- [WARN] Query latency: 150ms (acceptable)

### P3 - Low
- [INFO] VOYAGE_API_KEY not set (using local BGE)
- [INFO] {count} learnings stored
```

## Exit Codes

- `0` - All P0/P1 checks pass
- `1` - Any P0/P1 failure
- `2` - Only P2/P3 warnings

## Quick Mode (--quick)

Only run P0 checks:
1. Docker containers running (PostgreSQL, Redis)
2. PostgreSQL connected and pgvector installed
3. Embedding model loads
4. Frontmatter parses
5. Hooks build
6. Shell wrappers executable
7. TLDR accessible

## Comprehensive Mode (--comprehensive)

Run all checks including:
- Docker performance metrics
- Embedding latency tests
- Hook execution tests
- Cross-directory TLDR tests
- Settings validation
- Full cross-reference checking

Expected runtime: 2-3 minutes
