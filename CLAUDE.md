# CLAUDE.md

This file provides guidance for Claude Code when working with this repository.

## Project Overview

**Continuous Claude** - A persistent, learning, multi-agent development environment built on Claude Code. It transforms Claude Code into a continuously learning system that maintains context across sessions, orchestrates specialized agents, and eliminates wasting tokens through intelligent code analysis.

**Key Stats:**
- 107 Skills (modular capabilities)
- 16 Agents (specialized AI workers)
- 30 Hooks (lifecycle interceptors)
- 5-layer TLDR code analysis (95% token savings)

## Working Directory

Always work from `/Users/grantray/Github/Continuous-Claude-v3/` unless otherwise specified.

## Commands

### Python Commands (run from `opc/` directory)

```bash
# Install dependencies
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv sync

# Install with extras
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv sync --extra postgres  # PostgreSQL + pgvector
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv sync --extra math       # SymPy, Z3, Pint
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv sync --extra agentica   # Agentica SDK

# Run type checking
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run mypy .

# Run linter
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run ruff check .

# Run tests
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run pytest

# Run setup wizard
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run python -m scripts.setup.wizard

# Update installation
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run python -m scripts.setup.update

# Recall learnings from memory
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run python scripts/core/recall_learnings.py --query "search terms"

# Store a learning
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run python scripts/core/store_learning.py \
    --session-id "session-id" \
    --type WORKING_SOLUTION \
    --content "what you learned" \
    --confidence high
```

### TypeScript Hooks Commands (run from `.claude/hooks/`)

```bash
cd /Users/grantray/Github/Continuous-Claude-v3/.claude/hooks

# Build hooks
npm run build

# Type check
npm run check

# Run tests
npm run test
```

### TLDR Code Analysis

> **Note:** The 95% token savings refer to the external `llm-tldr` PyPI package. The local `opc/scripts/tldr/` module provides helper functions for AST-based analysis.

```bash
# Tree view
tldr tree src/

# Structure analysis
tldr structure src/ --lang python

# Search files
tldr search "pattern" src/

# Get function context
tldr context function_name --project src/ --depth 2

# Control flow graph
tldr cfg src/file.py function_name

# Data flow graph
tldr dfg src/file.py function_name

# Who calls this function (reverse call graph)
tldr impact function_name src/

# Find dead code
tldr dead src/

# Detect architecture layers
tldr arch src/

# Type check + lint
tldr diagnostics src/
```

## Architecture

```
continuous-claude/
├── .claude/                    # Claude Code integration
│   ├── agents/                # 16 specialized AI agents
│   │   ├── scout.json         # Codebase exploration
│   │   ├── kraken.json        # TDD implementation
│   │   ├── oracle.json        # External research
│   │   ├── maestro.json       # Multi-agent coordination
│   │   └── ... (10 more)
│   ├── hooks/                 # 30 lifecycle hooks
│   │   ├── src/               # TypeScript source
│   │   └── dist/              # Compiled JavaScript
│   ├── skills/                # 110 modular capabilities
│   │   ├── create_handoff/    # Session transfer
│   │   ├── tldr-code/         # Code analysis
│   │   ├── fix/               # Bug fixing workflow
│   │   └── ... (107 more)
│   ├── rules/                 # System policies
│   └── scripts/               # Python utilities
├── opc/                       # Main Python package
│   ├── scripts/
│   │   ├── setup/             # Wizard, Docker, integration
│   │   ├── core/              # recall_learnings, store_learning
│   │   ├── tldr/              # TLDR analysis scripts
│   │   └── mcp/               # MCP servers
│   ├── docker/
│   │   └── Dockerfile.sandbox # Docker container configuration
│   └── pyproject.toml         # Python dependencies
├── thoughts/                  # Continuity system (not tracked in git)
│   ├── ledgers/               # CONTINUITY_*.md files
│   └── shared/
│       ├── handoffs/          # Session handoffs (*.yaml)
│       └── plans/             # Implementation plans
└── docs/                      # Documentation
```

### Redis

A Redis container (`opc-redis`) handles caching and session storage alongside PostgreSQL.

| Property | Value |
|----------|-------|
| Port | 6379 |
| Status | Running |

## Key Entry Points

| Entry Point | Purpose |
|-------------|---------|
| `uv run python -m scripts.setup.wizard` | Initial setup and configuration |
| `uv run python -m scripts.setup.update` | Update hooks, skills, agents |
| `uv run python scripts/core/recall_learnings.py` | Query semantic memory |
| `uv run python scripts/core/store_learning.py` | Store new learnings |
| `npm run build` (in `.claude/hooks/`) | Compile TypeScript hooks |

## Key Files

| File | Purpose |
|------|---------|
| `/Users/grantray/Github/Continuous-Claude-v3/README.md` | Full project documentation |
| `/Users/grantray/Github/Continuous-Claude-v3/opc/pyproject.toml` | Python dependencies and config |
| `/Users/grantray/Github/Continuous-Claude-v3/.claude/hooks/package.json` | TypeScript hooks build config |
| `/Users/grantray/Github/Continuous-Claude-v3/.claude/settings.json` | Hook configuration |
| `/Users/grantray/Github/Continuous-Claude-v3/opc/scripts/README.md` | Script documentation |

## Skills System

Skills are modular capabilities triggered by natural language. Examples:

| Skill | Purpose |
|-------|---------|
| `/build` | Feature development workflow |
| `/fix` | Bug fixing workflow |
| `/explore` | Codebase exploration |
| `/handoff` | Create session transfer document |
| `/premortem` | Risk analysis |
| `tldr-code` | 5-layer code analysis |
| `qlty-check` | 70+ linters |
| `recall_learnings` | Query semantic memory |

## Agent System

Agents are specialized AI workers:

| Agent | Purpose |
|-------|---------|
| `scout` | Codebase exploration (use instead of Explore) |
| `oracle` | External research |
| `kraken` | TDD implementation |
| `sleuth` | Bug investigation |
| `maestro` | Multi-agent coordination |
| `phoenix` | Refactoring planning |

**Important:** Use `scout` agent for codebase exploration, not `Explore` agent.

## Memory System

Cross-session learning powered by PostgreSQL + pgvector:

```bash
# Recall relevant learnings
cd opc && uv run python scripts/core/recall_learnings.py --query "authentication patterns"

# Store a new learning
cd opc && uv run python scripts/core/store_learning.py \
    --session-id "auth-fix" \
    --type WORKING_SOLUTION \
    --content "JWT validation requires checking both signature and expiration" \
    --confidence high
```

## Claim Verification

When making claims about the codebase:

- **VERIFIED**: Read the file, traced the code
- **INFERRED**: Based on grep/search pattern - must verify
- **UNCERTAIN**: Haven't checked - must investigate

Never assert "X exists" or "X doesn't exist" without reading the actual files.

## Conventions

### Python
- Line length: 100 characters
- Type checking: mypy (strict mode)
- Linting: ruff (E, F, I, N, W, UP)
- Test files: `test_*.py`
- Python version: 3.12+

### TypeScript (Hooks)
- Format: ESM
- Build: esbuild
- Type checking: TypeScript
- Testing: vitest

### File Naming
- Python files: snake_case
- TypeScript files: kebab-case
- Configuration: kebab-case or snake_case as appropriate

## Common Workflows

```bash
# Fix a bug
claude
> /fix bug "description of bug"

# Build a feature
claude
> /build greenfield "feature description"

# Explore codebase
claude
> /explore quick   # ~1 min overview
> /explore deep    # ~5 min detailed analysis
> /explore architecture  # ~3 min architecture

# Research external information
claude
> "Research auth patterns for JWT"

# Remember something for future sessions
claude
> "Remember that X uses Y approach because Z"

# End session with handoff
claude
> "Done for today"  # Creates handoff for next session
```

## Important Notes

1. **Always run Python commands from `opc/` directory** - the pyproject.toml is there
2. **Use `scout` agent** instead of `Explore` for codebase exploration
3. **TLDR reduces tokens by 95%** - use `tldr context func_name` instead of reading full files
4. **Memory persists across sessions** - use `recall_learnings` to find past solutions
5. **Continuity ledger** tracks in-session state at `thoughts/ledgers/CONTINUITY_*.md`
6. **Handoffs** transfer knowledge between sessions at `thoughts/shared/handoffs/`
7. **TypeScript hooks must be built** after changes (`npm run build` in `.claude/hooks/`)
