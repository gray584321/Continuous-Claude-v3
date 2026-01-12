# Docker Auto-Connect

Automatic PostgreSQL Docker connection for Continuous-Claude-v3.

## Overview

This feature ensures PostgreSQL is always available when you start working. It automatically:
- Detects if the PostgreSQL Docker container is running
- Starts the container if it's stopped
- Waits for the container to be healthy
- Configures the `DATABASE_URL` environment variable
- Runs database migrations

## Usage

### Command Line (Recommended)

```bash
# Run the full auto-connect workflow
cd /Users/grantray/Github/Continuous-Claude-v3/opc
uv run python -m scripts.setup.wizard --docker-auto

# Or run the integration module directly
uv run python -m scripts.integration.docker_auto_connect

# Check status only (don't start)
uv run python -m scripts.integration.docker_auto_connect status

# Start container only
uv run python -m scripts.integration.docker_auto_connect start

# Wait for healthy
uv run python -m scripts.integration.docker_auto_connect wait
```

### Startup Hook

Run the startup hook directly to check PostgreSQL status:

```bash
uv run python -m scripts.hooks.docker_startup

# Verbose output
uv run python -m scripts.hooks.docker_startup --verbose

# Status only (don't start if stopped)
uv run python -m scripts.hooks.docker_startup --status-only

# Don't auto-start container
uv run python -m scripts.hooks.docker_startup --no-auto-start
```

### As a Module

```python
import asyncio
from scripts.integration.docker_auto_connect import auto_connect, check_and_connect

# Full auto-connect with all features
async def setup_postgres():
    status = await auto_connect(
        start_if_stopped=True,    # Start container if not running
        wait_for_healthy=True,    # Wait for container to be healthy
        run_migrations_flag=True, # Run database migrations
        set_env=True,             # Set DATABASE_URL in environment
        verbose=True,             # Show detailed output
    )

    if status.database_reachable:
        print("PostgreSQL is ready!")
        print(f"DATABASE_URL: {status.database_url}")

# Quick check - just verify and connect
async def quick_check():
    status = await check_and_connect()
    print(f"Database reachable: {status.database_reachable}")
```

## Exit Codes

The `docker_auto_connect` script returns the following exit codes:

| Code | Meaning |
|------|---------|
| 0 | Success - PostgreSQL is available |
| 1 | Error - PostgreSQL not available |
| 10 | Docker daemon not running |
| 11 | Container issue |

## Files Created

| File | Purpose |
|------|---------|
| `opc/scripts/integration/docker_auto_connect.py` | Main auto-connect module |
| `opc/scripts/hooks/docker_startup.py` | Startup hook for status checks |

## Configuration

### Default PostgreSQL Settings

```yaml
Container: opc-postgres
Host: localhost
Port: 5432
Database: continuous_claude
User: claude
Password: claude_dev
```

### Environment Variables

The following environment variables are set by auto-connect:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Full connection string for PostgreSQL |
| `POSTGRES_HOST` | PostgreSQL host (localhost) |
| `POSTGRES_PORT` | PostgreSQL port (5432) |
| `POSTGRES_DB` | Database name |
| `POSTGRES_USER` | Database user |
| `POSTGRES_PASSWORD` | Database password |

## Integration with Wizard

The `--docker-auto` flag integrates with the setup wizard:

```bash
# Full wizard with auto-connect
uv run python -m scripts.setup.wizard --docker-auto
```

This runs:
1. Database URL detection
2. Container startup (if needed)
3. Health check wait
4. Database migrations

## Troubleshooting

### Docker Not Running

```
ERROR: Docker daemon not running
```

Start Docker Desktop or the Docker service:
```bash
# macOS
open -a Docker

# Linux
sudo systemctl start docker

# Linux (user namespace)
systemctl --user start docker
```

### Container Won't Start

```bash
# Check logs
docker compose -f /path/to/docker/docker-compose.yml logs postgres

# Check if port is in use
lsof -i :5432

# Remove stuck container
docker rm -f opc-postgres
```

### Container Not Healthy

```bash
# Check container health
docker inspect opc-postgres --format='{{.State.Health.Status}}'

# Check logs
docker logs opc-postgres
```

### DATABASE_URL Not Set

```bash
# Check if .env exists
cat .env | grep DATABASE_URL

# Run auto-connect to set it
uv run python -m scripts.setup.wizard --docker-auto
```

## Adding to Shell Profile

Add to your shell profile for automatic startup:

```bash
# ~/.zshrc or ~/.bashrc

# Auto-start PostgreSQL on shell startup (optional)
auto_postgres() {
    cd ~/Github/Continuous-Claude-v3/opc
    uv run python -m scripts.integration.docker_auto_connect > /dev/null 2>&1
    cd - > /dev/null
}

# Uncomment to enable auto-start:
# auto_postgres
```

## Programmatic Integration

Add to your own scripts:

```python
#!/usr/bin/env python3
"""My script that needs PostgreSQL."""

import asyncio
import sys

async def main():
    from scripts.integration.docker_auto_connect import auto_connect

    # Ensure PostgreSQL is available
    status = await auto_connect(
        start_if_stopped=True,
        wait_for_healthy=True,
        run_migrations_flag=False,  # Skip migrations if not needed
        set_env=True,
    )

    if not status.database_reachable:
        print(f"ERROR: PostgreSQL not available: {status.error}")
        sys.exit(1)

    # Now you can use DATABASE_URL
    import os
    db_url = os.environ["DATABASE_URL"]
    print(f"Connected to: {db_url}")

    # Your code here...

if __name__ == "__main__":
    asyncio.run(main())
```
