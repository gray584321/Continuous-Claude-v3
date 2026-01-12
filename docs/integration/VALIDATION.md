# Validation Guide

This document describes how to validate your Continuous-Claude-v3 installation.

## Using the Validation Script

### Run All Validations

```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
python scripts/integration/validate_installation.py
```

### Component-Specific Validation

```bash
# Only check database
python scripts/integration/validate_installation.py --component database

# Only check wizard
python scripts/integration/validate_installation.py --component wizard

# Only check TLDR
python scripts/integration/validate_installation.py --component tldr

# Only check hooks
python scripts/integration/validate_installation.py --component hooks
```

### JSON Output

```bash
# Machine-readable JSON output
python scripts/integration/validate_installation.py --json
```

### Verbose Output

```bash
# Detailed output
python scripts/integration/validate_installation.py --verbose
```

## What Gets Validated

### Database Checks

| Check | Description | Fix Command |
|-------|-------------|-------------|
| PostgreSQL Connection | Tests database connectivity | Start Docker or check DATABASE_URL |
| Database Schema | Verifies required tables exist | `python -m scripts.setup.docker_setup migrate` |
| pgvector Extension | Checks vector extension is enabled | `CREATE EXTENSION IF NOT EXISTS vector;` |

### Wizard Checks

| Check | Description | Fix Command |
|-------|-------------|-------------|
| Wizard Script | Verifies wizard.py exists | Reinstall OPC |
| Claude Home | Checks ~/.claude directory | `python -m scripts.setup.wizard` |

### Hooks Checks

| Check | Description | Fix Command |
|-------|-------------|-------------|
| Built Hooks | Checks hooks/dist for .mjs files | `cd ~/.claude/hooks && npm install && npm run build` |
| Skills | Counts installed skills | Reinstall OPC |
| Rules | Counts installed rules | Reinstall OPC |

### TLDR Checks

| Check | Description | Fix Command |
|-------|-------------|-------------|
| TLDR Installed | Checks tldr is on PATH | `pip install llm-tldr` |
| Symbol Index | Verifies symbol index exists | `tldr index .` |

### Health Checks

| Check | Description |
|-------|-------------|
| Python Version | Requires 3.11+ |
| UV Package Manager | Checks uv is installed |
| OPC Dependencies | Verifies pyproject.toml and virtual environment |
| Docker Running | Checks Docker daemon is accessible |
| Health Checks | Runs full health check suite |

## Expected Outputs

### All Checks Passing

```
====================================================
CONTINUOUS-CLAUDE-V3 VALIDATION REPORT
====================================================
Timestamp: 2024-01-01T00:00:00
Components Checked: DATABASE, WIZARD, HOOKS, TLDR, HEALTH

SUMMARY
----------------------------------------
  Passed:   12
  Failed:   0
  Warnings: 1
  Skipped:  0

====================================================
[OK] All validation checks passed!
====================================================
```

### Some Checks Failed

```
====================================================
CONTINUOUS-CLAUDE-V3 VALIDATION REPORT
====================================================
...
[FAIL] Some validation checks failed.

To fix common issues, run:
  cd opc && uv sync
  python -m scripts.setup.wizard --update
  python -m scripts.setup.docker_setup migrate
====================================================
```

## Common Error Messages

### DATABASE_URL Not Set

```
[WARN] DATABASE_URL not set
Fix: Run: source .env
```

**Solution**: Set the DATABASE_URL environment variable:
```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
source .env
```

### PostgreSQL Connection Failed

```
[FAIL] PostgreSQL connection failed: connection refused
Fix: Check DATABASE_URL or run: docker compose up -d
```

**Solution**: Start the Docker stack:
```bash
cd /Users/grantray/Github/Continuous-Claude-v3/docker
docker compose up -d
```

### pgvector Extension Not Enabled

```
[FAIL] pgvector extension not enabled
Fix: Run: CREATE EXTENSION IF NOT EXISTS vector;
```

**Solution**: Enable the extension:
```bash
psql "$DATABASE_URL" -c "CREATE EXTENSION IF NOT EXISTS vector;"
```

### Hooks Not Built

```
[FAIL] hooks/dist not found
Fix: Run: python -m scripts.setup.wizard
```

**Solution**: Run the wizard to build hooks:
```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
python -m scripts.setup.wizard
```

### TLDR Not Installed

```
[FAIL] TLDR not found in PATH
Fix: pip install llm-tldr
```

**Solution**: Install TLDR:
```bash
pip install llm-tldr
```

## Validation in CI/CD

### GitHub Actions

```yaml
- name: Validate Installation
  run: |
    cd opc
    python scripts/integration/validate_installation.py --json > validation.json
    # Check if all checks passed
    if [ $(jq -r '.all_passed' validation.json) = "true" ]; then
      echo "All checks passed"
    else
      echo "Some checks failed"
      exit 1
    fi
```

### Docker Environment

```bash
# In Dockerfile or docker-compose
RUN cd /app/opc && python scripts/integration/validate_installation.py
```

## Manual Health Checks

### Run Health Checks Directly

```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
uv run python scripts/core/health_check.py status
uv run python scripts/core/health_check.py liveness
uv run python scripts/core/health_check.py readiness
uv run python scripts/core/health_check.py startup
```

### Run Wizard Validation

```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
uv run python -m scripts.setup.wizard validate
uv run python -m scripts.setup.wizard validate --json
```

## Troubleshooting Validation Failures

### Step 1: Check Prerequisites

```bash
# Verify Python version
python --version

# Verify uv is installed
uv --version

# Verify Docker is running
docker info
```

### Step 2: Check Environment

```bash
# Verify .env exists
cat opc/.env

# Verify DATABASE_URL is set
echo $DATABASE_URL
```

### Step 3: Re-run Wizard

```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
uv run python -m scripts.setup.wizard --update --force
```

### Step 4: Check Logs

```bash
# Check wizard log
cat ~/.claude/wizard.log

# Check health check log
cat ~/.claude/memory-daemon.log
```

### Step 5: File Issue

If validation continues to fail:
1. Run validation with `--json` flag
2. Include the JSON output in your issue report
3. Describe the expected vs actual behavior
