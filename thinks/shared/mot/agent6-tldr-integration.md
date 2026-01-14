# TLDR Integration Research for MOT

## Overview

TLDR (Token-efficient code analysis) is a CLI tool designed to provide structured code analysis for LLMs with **95% token savings** compared to raw file reads. This document provides comprehensive validation strategies for ensuring TLDR works reliably across any repository within the MOT (Model Optimization Toolkit) context.

---

## 1. TLDR Installation Validation

### 1.1 Package Installation Check

```bash
# Verify llm-tldr package is installed
uv pip show llm-tldr

# Expected output includes:
# Name: llm-tldr
# Version: x.x.x
# Location: ~/.venv/lib/python3.x/site-packages
```

**Validation Points:**
- Package name must be `llm-tldr` (not to be confused with man-page `tldr`)
- Version should be recent (2024+)
- Location should be within the project's virtual environment

### 1.2 Symlink Verification

```bash
# Check symlink exists
ls -la /usr/local/bin/tldr

# Verify symlink points to venv
readlink /usr/local/bin/tldr
# Expected: /path/to/.venv/bin/tldr

# Verify tldr is executable
tldr --help | head -5
# Expected: "Token-efficient code analysis"
```

**Symlink Installation Script Location:** `/Users/grantray/Github/Continuous-Claude-v3/opc/scripts/setup/tldr_installer.py`

**Key Functions:**
- `ensure_tldr_symlink(tldr_bin, symlink_path, verbose)` - Creates/verifies symlink
- `install_tldr_code(tldr_bin, symlink_path, verbose)` - Full installation
- `check_tldr_update(tldr_bin, symlink_path)` - Checks for updates
- `uninstall_tldr_code(symlink_path, verbose)` - Removes symlink

### 1.3 Virtual Environment Integration

```bash
# Check venv bin directory
ls -la /Users/grantray/Github/Continuous-Claude-v3/opc/.venv/bin/tldr
ls -la /Users/grantray/Github/Continuous-Claude-v3/opc/.venv/bin/llm-tldr

# Both should exist and be executable
```

**Integration Test File:** `/Users/grantray/Github/Continuous-Claude-v3/opc/tests/test_tldr_installation.py`

Key test cases cover:
- Fresh installation flow
- Already-installed handling
- Broken symlink recovery
- Permission denied scenarios
- Verbose output verification

---

## 2. TLDR Functionality Validation

### 2.1 Core Analysis Commands

```bash
# Syntax: tldr <command> <path> [--lang <language>] [options]

# File tree visualization
tldr tree /path/to/project --ext .py --depth 2

# Code structure extraction (functions, classes, imports)
tldr structure /path/to/project --lang python

# Full file info extraction
tldr extract /path/to/file.py

# Pattern search
tldr search "pattern" /path/to/project
```

**Validation Checklist:**
- [ ] `tree` produces JSON with `files` array
- [ ] `structure` returns language detection
- [ ] `extract` includes functions, classes, imports
- [ ] `search` returns matching locations

### 2.2 Flow Analysis Commands

```bash
# Control flow graph (complexity, branches)
tldr cfg /path/to/file.py function_name

# Data flow graph (variable definitions/uses)
tldr dfg /path/to/file.py function_name

# Program slice (what affects line X)
tldr slice /path/to/file.py function_name 42

# Cross-file call graph
tldr calls /path/to/project
```

**Performance Notes:**
- CFG adds ~110 tokens
- DFG adds ~130 tokens
- PDG adds ~150 tokens
- Total layered analysis: ~1,200 tokens vs 23,000 raw = 95% savings

### 2.3 Impact Analysis Commands

```bash
# Reverse call graph (who calls function X)
tldr impact function_name /path/to/project --depth 3

# Find dead/unused code
tldr dead /path/to/project --entry main

# Detect architectural layers
tldr arch /path/to/project
```

**Example Output (dead code):**
```json
{
  "dead_functions": [
    {"file": "normalize_fields.py", "function": "update_normalization_config"},
    {"file": "normalize_fields.py", "function": "get_normalization_strategy"}
  ],
  "by_file": {
    "normalize_fields.py": ["update_normalization_config", "get_normalization_strategy"]
  },
  "total_dead": 2,
  "total_functions": 56,
  "dead_percentage": 3.6
}
```

### 2.4 Import Analysis Commands

```bash
# Parse imports from a file
tldr imports /path/to/file.py --lang python

# Find all files importing a module
tldr importers module_name /path/to/project --lang python
```

### 2.5 Quality & Diagnostics Commands

```bash
# Type check + lint (pyright + ruff)
tldr diagnostics /path/to/project --format text

# Find affected tests after changes
tldr change-impact --git --run
```

---

## 3. OPC Runtime Integration

### 3.1 Integration Points

**Location:** `/Users/grantray/Github/Continuous-Claude-v3/opc/scripts/tldr/`

| File | Purpose |
|------|---------|
| `tldr_api.py` | Core TLDR API wrappers |
| `build_symbol_index.py` | Symbol index building |
| `index_db.py` | Database storage for indices |
| `index_incremental.py` | Incremental re-indexing |
| `health_check.py` | Health monitoring |
| `validate_tldr.py` | Comprehensive validation |

### 3.2 API Functions

**tldr_api.py exports:**
- `scan_project_files(path)` - Scan directory for source files
- `extract_file(file_path)` - Extract symbols from file
- `extract_symbols(content, language)` - Parse symbols from content
- `build_function_index(files)` - Build index from files
- `extract_calls(content, language)` - Extract function calls

### 3.3 Database Integration

**SQLite Location:** `~/.claude/cache/tldr_index.db`

**PostgreSQL:** When `DATABASE_URL` is set, uses PostgreSQL with connection pooling.

**Schema:**
- `tldr_index_state` - Tracks index state and freshness
- `tldr_index_metadata` - Stores file metadata

---

## 4. Validation Strategies

### 4.1 Quick Health Checks

```bash
# Command-line health check
tldr doctor

# Expected output shows available tools per language:
# Python:
#   ✓ pyright - /path/to/pyright
#   ✗ ruff - not found (install recommendation)

# Script-based health check
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/health_check.py
```

**Health Check Classes:**
- `TldrIndexTablesCheck` - Verifies database tables exist
- `TldrIndexFreshnessCheck` - Checks if index is current
- `TldrSymbolIndexCheck` - Validates symbol index

### 4.2 Comprehensive Validation Script

**Location:** `/Users/grantray/Github/Continuous-Claude-v3/opc/scripts/tldr/validate_tldr.py`

```bash
# Run all validation tests
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/validate_tldr.py all

# Run specific tests
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/validate_tldr.py api
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/validate_tldr.py db
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/validate_tldr.py build

# With fix mode
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/validate_tldr.py all --fix
```

**Test Categories:**
| Test | Purpose | Expected Result |
|------|---------|-----------------|
| `api` | TLDR API imports | All functions callable |
| `db` | Database connection | PostgreSQL or SQLite connected |
| `schema` | Database schema validation | State read/write works |
| `build` | Symbol extraction | Python/TypeScript functions found |
| `incremental` | Git integration | Commit hash and file hashes work |
| `health` | Health checks | All checks pass |
| `script` | Build script imports | No import errors |
| `tests` | Unit tests | All tests pass |

### 4.3 Integration Tests

**Test File:** `/Users/grantray/Github/Continuous-Claude-v3/opc/tests/test_tldr_indexing.py`

```bash
# Run tldr-specific tests
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run pytest tests/test_tldr_indexing.py -v
cd /Users/grantray/Github/Continuous-Claude-v3/opc && uv run pytest tests/test_tldr_installation.py -v
```

---

## 5. Performance Validation

### 5.1 Token Efficiency Benchmark

The 5-layer analysis stack:

| Layer | Tokens Added | Purpose |
|-------|--------------|---------|
| 1. AST | ~500 | Function signatures, imports |
| 2. Call Graph | +440 | Cross-file dependencies |
| 3. CFG | +110 | Complexity, branches |
| 4. DFG | +130 | Variable flow |
| 5. PDG | +150 | Dependencies, slicing |
| **Total** | **~1,200** | vs 23,000 raw |

### 5.2 Indexing Performance

```bash
# Warm up index (pre-compute analysis)
tldr warm /path/to/project --project

# Rebuild call graph
tldr calls /path/to/project

# Check indexing status
tldr semantic index /path/to/project --project
```

**Typical Performance:**
- Small project (< 100 files): ~2-5 seconds
- Medium project (100-1000 files): ~10-30 seconds
- Large project (> 1000 files): ~1-5 minutes

### 5.3 Caching Strategy

**Cache Location:** `~/.claude/cache/symbol-index/`

**Cached Files:**
- `symbols.json` - Function/class locations
- `callers.json` - Reverse call graph
- Index state with commit hash

**Invalidation:** Automatic on git commit detection

---

## 6. Cross-Platform Validation

### 6.1 macOS Validation

```bash
# Verify installation
which tldr
# Expected: /usr/local/bin/tldr

# Check doctor output
tldr doctor | grep -E "✓|✗"

# Verify Python tools
tldr doctor | grep -A5 "Python"
```

### 6.2 Linux Validation

```bash
# Check sudo access for symlink
sudo ls /usr/local/bin/tldr

# Verify cppcheck availability
tldr doctor | grep -A2 "C:"
```

### 6.3 Container Validation

```bash
# In Dockerfile, validate at build time
RUN which tldr && tldr --help | head -3

# Or validate after container startup
RUN tldr doctor
```

---

## 7. Troubleshooting Guide

### 7.1 Common Issues

| Issue | Cause | Solution |
|-------|-------|----------|
| "Command not found" | Symlink missing | Re-run `tldr_installer` |
| "wrong tldr" | Man-page tldr instead of llm-tldr | Uninstall man-page, reinstall llm-tldr |
| "pyright not found" | Type checker not installed | `pip install pyright` |
| "ruff not found" | Linter not installed | `pip install ruff` |
| Index stale | No git commit | Check git integration |

### 7.2 Recovery Procedures

**Symlink Recovery:**
```bash
# Remove broken symlink
sudo rm /usr/local/bin/tldr

# Re-create symlink
sudo ln -sf /Users/grantray/Github/Continuous-Claude-v3/opc/.venv/bin/tldr /usr/local/bin/tldr
```

**Index Rebuild:**
```bash
# Clear cache
rm -rf ~/.claude/cache/symbol-index/

# Rebuild
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/build_symbol_index.py
```

### 7.3 Verification Commands

```bash
# 1. Basic availability
tldr --help

# 2. Package verification
uv pip show llm-tldr

# 3. Symlink verification
ls -la /usr/local/bin/tldr
readlink /usr/local/bin/tldr

# 4. Functional test
tldr structure /Users/grantray/Github/Continuous-Claude-v3/opc/pyproject.toml --lang python

# 5. Health check
tldr doctor

# 6. Integration test
cd /Users/grantray/Github/Continuous-Claude-v3/opc && PYTHONPATH=. uv run python scripts/tldr/validate_tldr.py all
```

---

## 8. Validation Checklist for MOT

### 8.1 Pre-Installation
- [ ] Python 3.9+ installed
- [ ] uv package manager available
- [ ] Project venv created and activated
- [ ] Sudo access available (for symlink)

### 8.2 Installation
- [ ] `uv pip install llm-tldr` succeeds
- [ ] `~/.venv/bin/tldr` exists
- [ ] `~/.venv/bin/llm-tldr` exists
- [ ] Symlink at `/usr/local/bin/tldr` created
- [ ] `tldr --help` returns expected output

### 8.3 Functionality
- [ ] `tldr tree` works on project
- [ ] `tldr structure` detects language
- [ ] `tldr extract` returns functions/classes
- [ ] `tldr impact` finds callers
- [ ] `tldr dead` finds unused functions
- [ ] `tldr diagnostics` runs type check

### 8.4 Integration
- [ ] OPC scripts import correctly
- [ ] Database connection works
- [ ] Index building completes
- [ ] Incremental indexing triggers
- [ ] Health checks pass

### 8.5 Performance
- [ ] Index build completes in < 5 min
- [ ] Individual queries < 1 sec
- [ ] Token savings verified (>90%)
- [ ] Cache files created

---

## 9. Source References

1. [TLDR-Code GitHub](https://github.com/agentica-llc/tldr-code) - Official repository
2. [CLAUDE.md - TLDR Section](/Users/grantray/Github/Continuous-Claude-v3/CLAUDE.md) - Project documentation
3. [tldr_installer.py](/Users/grantray/Github/Continuous-Claude-v3/opc/scripts/setup/tldr_installer.py) - Installation logic
4. [validate_tldr.py](/Users/grantray/Github/Continuous-Claude-v3/opc/scripts/tldr/validate_tldr.py) - Validation framework
5. [test_tldr_installation.py](/Users/grantray/Github/Continuous-Claude-v3/opc/tests/test_tldr_installation.py) - Installation tests
6. [test_tldr_indexing.py](/Users/grantray/Github/Continuous-Claude-v3/opc/tests/test_tldr_indexing.py) - Indexing tests

---

## 10. Quick Validation Commands Summary

```bash
# ONE-LINER: Full validation
tldr --help && uv pip show llm-tldr && tldr structure . --lang python | head -5

# Daemon mode for background indexing
tldr daemon start
tldr daemon status

# Semantic search
tldr semantic search "authentication" --project .

# Help for specific command
tldr <command> --help
```

This validation framework ensures TLDR works reliably across all repositories by testing installation, functionality, integration, and performance systematically.
