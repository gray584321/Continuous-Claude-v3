#!/usr/bin/env python3
"""Docker Auto-Connect for PostgreSQL.

Provides automatic detection and connection to PostgreSQL Docker containers.
This module ensures the Continuous-Claude PostgreSQL container is running
and properly configured before operations that require database access.

USAGE:
    # As a module
    from scripts.integration.docker_auto_connect import auto_connect
    result = await auto_connect()

    # As a script
    python -m scripts.integration.docker_auto_connect
"""

import asyncio
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

# Ensure project root is in sys.path for imports when run as a script
_this_file = Path(__file__).resolve()
_project_root = _this_file.parent.parent.parent  # scripts/integration/ -> scripts/ -> opc/
if str(_project_root) not in __import__("sys").path:
    __import__("sys").path.insert(0, str(_project_root))

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.prompt import Confirm

    console = Console()
except ImportError:

    class Console:
        def print(self, *args, **kwargs):
            print(*args)

    console = Console()


# Default paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
DOCKER_DIR = PROJECT_ROOT.parent / "docker"
DOCKER_COMPOSE_FILE = DOCKER_DIR / "docker-compose.yml"
ENV_FILE = PROJECT_ROOT / ".env"

# Container runtime - "docker" or "podman"
_CONTAINER_RUNTIME = "docker"


def set_container_runtime(runtime: str) -> None:
    """Set the container runtime to use (docker or podman)."""
    global _CONTAINER_RUNTIME
    _CONTAINER_RUNTIME = runtime


def get_container_runtime() -> str:
    """Get the current container runtime."""
    return _CONTAINER_RUNTIME


@dataclass
class DockerPostgresStatus:
    """Status of the PostgreSQL Docker container."""

    container_running: bool = False
    container_healthy: bool = False
    database_reachable: bool = False
    database_url: str = ""
    error: str | None = None


async def check_docker_postgres_running() -> dict[str, Any]:
    """Check if the PostgreSQL Docker container is currently running.

    Returns:
        dict with keys:
            - running: bool - Container is up (regardless of health status)
            - healthy: bool - Container is healthy
            - container_name: str - Name of the container
            - status: str - Human-readable status
    """
    result = {
        "running": False,
        "healthy": False,
        "container_name": "",
        "status": "unknown",
    }

    try:
        # Get container name from compose file or use default
        container_name = "opc-postgres"

        # Check container status
        cmd = [
            _CONTAINER_RUNTIME,
            "ps",
            "--filter",
            f"name={container_name}",
            "--format",
            "{{.Names}}::{{.Status}}::{{.Health}}",
        ]

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0 and stdout.decode().strip():
            output = stdout.decode().strip()
            # Format: name::status::health
            parts = output.split("::")
            result["container_name"] = parts[0] if parts else container_name

            if len(parts) >= 2:
                status = parts[1]
                result["running"] = "up" in status.lower()
                result["status"] = status

            if len(parts) >= 3:
                health = parts[2].lower()
                result["healthy"] = health == "healthy"

            if result["running"] and not result["healthy"]:
                result["status"] = f"{result['status']} (starting)"
        else:
            result["status"] = "not found"

    except FileNotFoundError:
        result["status"] = "docker not installed"
        result["error"] = f"{_CONTAINER_RUNTIME} not found in PATH"
    except Exception as e:
        result["status"] = "error"
        result["error"] = str(e)

    return result


async def start_postgres_container() -> dict[str, Any]:
    """Start the PostgreSQL Docker container if it's stopped.

    Returns:
        dict with keys:
            - success: bool - Container was started successfully
            - output: str - Command output
            - error: str - Error message if failed
    """
    result = {"success": False, "output": "", "error": None}

    try:
        if not DOCKER_COMPOSE_FILE.exists():
            result["error"] = f"Docker compose file not found: {DOCKER_COMPOSE_FILE}"
            return result

        cmd = [
            _CONTAINER_RUNTIME,
            "compose",
            "-f",
            str(DOCKER_COMPOSE_FILE),
            "up",
            "-d",
            "postgres",
        ]

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0:
            result["success"] = True
            result["output"] = stdout.decode().strip()
        else:
            result["error"] = stderr.decode().strip()

    except Exception as e:
        result["error"] = str(e)

    return result


async def wait_for_health(
    timeout: int = 60,
    service: str = "postgres",
) -> dict[str, Any]:
    """Wait for a Docker service to become healthy.

    Args:
        timeout: Maximum seconds to wait
        service: Service name to check (default: postgres)

    Returns:
        dict with keys:
            - healthy: bool - Service is healthy
            - elapsed: float - Time elapsed in seconds
            - error: str - Error message if failed
    """
    result = {"healthy": False, "elapsed": 0.0, "error": None}

    if not DOCKER_COMPOSE_FILE.exists():
        result["error"] = f"Docker compose file not found: {DOCKER_COMPOSE_FILE}"
        return result

    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < timeout:
        try:
            cmd = [
                _CONTAINER_RUNTIME,
                "compose",
                "-f",
                str(DOCKER_COMPOSE_FILE),
                "ps",
                service,
                "--format",
                "{{.Health}}",
            ]

            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()

            health = stdout.decode().strip().lower()
            if health == "healthy":
                result["healthy"] = True
                result["elapsed"] = asyncio.get_event_loop().time() - start_time
                return result

        except Exception as e:
            result["error"] = str(e)
            # Continue waiting despite errors

        await asyncio.sleep(1)

    result["elapsed"] = timeout
    return result


async def detect_database_url() -> str | None:
    """Detect the database URL from environment or Docker container.

    Returns:
        str: DATABASE_URL if found, None otherwise
    """
    # Check environment variable first
    if os.environ.get("DATABASE_URL"):
        return os.environ.get("DATABASE_URL")

    # Check .env file
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip()

    # Try to extract from Docker container environment
    try:
        container_name = "opc-postgres"
        cmd = [
            _CONTAINER_RUNTIME,
            "exec",
            container_name,
            "env",
            "|",
            "grep",
            "DATABASE_URL",
        ]

        process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await process.communicate()

        if process.returncode == 0 and stdout.decode().strip():
            line = stdout.decode().strip()
            if "=" in line:
                return line.split("=", 1)[1].strip()
    except Exception:
        pass

    return None


async def set_database_url(url: str) -> bool:
    """Set the DATABASE_URL in the .env file.

    Args:
        url: The database URL to set

    Returns:
        bool: True if successfully set
    """
    try:
        lines = []
        if ENV_FILE.exists():
            lines = ENV_FILE.read_text().splitlines()

        # Update or add DATABASE_URL
        found = False
        new_lines = []
        for line in lines:
            if line.startswith("DATABASE_URL="):
                new_lines.append(f"DATABASE_URL={url}")
                found = True
            else:
                new_lines.append(line)

        if not found:
            new_lines.append(f"DATABASE_URL={url}")

        ENV_FILE.write_text("\n".join(new_lines))
        return True

    except Exception:
        return False


async def run_migrations() -> dict[str, Any]:
    """Run database migrations.

    Returns:
        dict with keys:
            - success: bool - Migrations ran successfully
            - applied: list[str] - Applied migration names
            - error: str - Error message if failed
    """
    result = {"success": False, "applied": [], "error": None}

    # Run init schema first (memory tables)
    init_sql = DOCKER_DIR / "init-schema.sql"
    if init_sql.exists():
        try:
            cmd = [
                _CONTAINER_RUNTIME,
                "compose",
                "-f",
                str(DOCKER_COMPOSE_FILE),
                "exec",
                "-T",
                "postgres",
                "psql",
                "-U",
                "claude",
                "-d",
                "continuous_claude",
                "-f",
                "/docker-entrypoint-initdb.d/init-schema.sql",
            ]

            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, stderr = await process.communicate()

            if process.returncode != 0:
                result["error"] = stderr.decode().strip()
                return result

        except Exception as e:
            result["error"] = str(e)
            return result

    # Run any additional migrations
    migrations_dir = PROJECT_ROOT / "scripts" / "migrations"
    if migrations_dir.exists():
        for sql_file in sorted(migrations_dir.glob("*.sql")):
            try:
                cmd = [
                    _CONTAINER_RUNTIME,
                    "compose",
                    "-f",
                    str(DOCKER_COMPOSE_FILE),
                    "exec",
                    "-T",
                    "postgres",
                    "psql",
                    "-U",
                    "claude",
                    "-d",
                    "continuous_claude",
                    "-f",
                    f"/migrations/{sql_file.name}",
                ]

                process = await asyncio.create_subprocess_exec(
                    *cmd,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                )
                stdout, stderr = await process.communicate()

                if process.returncode != 0:
                    result["error"] = stderr.decode().strip()
                    return result

                result["applied"].append(sql_file.name)

            except Exception as e:
                result["error"] = str(e)
                return result

    result["success"] = True
    return result


async def auto_connect(
    start_if_stopped: bool = True,
    wait_for_healthy: bool = True,
    run_migrations_flag: bool = True,
    set_env: bool = True,
    verbose: bool = False,
) -> DockerPostgresStatus:
    """Main function to ensure PostgreSQL Docker container is available.

    This function:
    1. Checks if the PostgreSQL container is running
    2. Starts it if stopped (if start_if_stopped=True)
    3. Waits for it to become healthy (if wait_for_healthy=True)
    4. Detects and sets DATABASE_URL (if set_env=True)
    5. Runs migrations (if run_migrations_flag=True)

    Args:
        start_if_stopped: Start container if not running
        wait_for_healthy: Wait for container to be healthy
        run_migrations_flag: Run database migrations
        set_env: Set DATABASE_URL in environment
        verbose: Show detailed output

    Returns:
        DockerPostgresStatus with connection details
    """
    status = DockerPostgresStatus()

    console.print(Panel.fit(
        "[bold]PostgreSQL Docker Auto-Connect[/bold]",
        border_style="blue"
    ))

    # Step 1: Check if Docker is available
    docker_path = shutil.which(_CONTAINER_RUNTIME)
    if docker_path is None:
        status.error = f"{_CONTAINER_RUNTIME} not found in PATH"
        console.print(f"  [red]ERROR[/red] {_CONTAINER_RUNTIME} not installed")
        console.print(f"  Install with: brew install --cask docker (macOS)")
        return status

    console.print(f"  [dim]Using {_CONTAINER_RUNTIME} at {docker_path}[/dim]")

    # Step 2: Check if container is running
    console.print("\n[bold]Checking PostgreSQL container...[/bold]")
    container_status = await check_docker_postgres_running()

    if container_status["running"]:
        console.print(f"  [green]OK[/green] Container is running")
        console.print(f"  [dim]Status: {container_status['status']}[/dim]")
        status.container_running = True
    else:
        console.print(f"  [yellow]WARN[/yellow] Container not running")
        console.print(f"  [dim]Status: {container_status.get('status', 'unknown')}[/dim]")

        if start_if_stopped:
            console.print("\n[bold]Starting PostgreSQL container...[/bold]")
            start_result = await start_postgres_container()
            if start_result["success"]:
                console.print("  [green]OK[/green] Container started")
                status.container_running = True
            else:
                status.error = start_result.get("error", "Failed to start container")
                console.print(f"  [red]ERROR[/red] {status.error}")
                return status
        else:
            status.error = "Container not running and start_if_stopped=False"
            return status

    # Step 3: Wait for healthy status
    if wait_for_healthy:
        console.print("\n[bold]Waiting for PostgreSQL to be healthy...[/bold]")
        health = await wait_for_health(timeout=60)

        if health["healthy"]:
            console.print(f"  [green]OK[/green] PostgreSQL is healthy (elapsed: {health['elapsed']:.1f}s)")
            status.container_healthy = True
        else:
            console.print(f"  [yellow]WARN[/yellow] PostgreSQL not healthy within timeout")
            if health.get("error"):
                console.print(f"  [dim]Error: {health['error']}[/dim]")
    else:
        # Still mark as healthy if running (non-healthy means starting)
        status.container_healthy = container_status.get("healthy", False)

    # Step 4: Detect and set DATABASE_URL
    console.print("\n[bold]Detecting database URL...[/bold]")
    db_url = await detect_database_url()

    if db_url:
        console.print(f"  [green]OK[/green] Found: postgresql://...")
        status.database_url = db_url

        if set_env:
            # Set in environment
            os.environ["DATABASE_URL"] = db_url

            # Also set in .env file
            if await set_database_url(db_url):
                console.print("  [green]OK[/green] Set DATABASE_URL in .env")
    else:
        # Generate default URL if container is running
        if status.container_running:
            db_url = "postgresql://claude:claude_dev@localhost:5432/continuous_claude"
            console.print(f"  [yellow]WARN[/yellow] No DATABASE_URL found, using default")
            console.print(f"  [dim]postgresql://claude:claude_dev@localhost:5432/continuous_claude[/dim]")

            if set_env:
                os.environ["DATABASE_URL"] = db_url
                if await set_database_url(db_url):
                    console.print("  [green]OK[/green] Set default DATABASE_URL in .env")

            status.database_url = db_url
        else:
            status.error = "Container not running and no DATABASE_URL found"
            console.print(f"  [red]ERROR[/red] {status.error}")

    # Step 5: Run migrations
    if run_migrations_flag and status.container_healthy:
        console.print("\n[bold]Running database migrations...[/bold]")
        mig_result = await run_migrations()

        if mig_result["success"]:
            if mig_result["applied"]:
                console.print(f"  [green]OK[/green] Applied: {', '.join(mig_result['applied'])}")
            else:
                console.print("  [dim]No new migrations[/dim]")
        else:
            console.print(f"  [yellow]WARN[/yellow] Migration error: {mig_result.get('error')}")

    # Final status
    console.print("\n" + "=" * 60)
    console.print("[bold]PostgreSQL Status[/bold]")

    status.database_reachable = status.container_healthy and bool(status.database_url)

    if status.database_reachable:
        console.print("  [green]READY[/green] PostgreSQL is available")
        console.print(f"  [dim]DATABASE_URL is set[/dim]")
    elif status.container_running:
        console.print("  [yellow]PARTIAL[/yellow] Container running but not ready")
    else:
        console.print("  [red]NOT AVAILABLE[/bold] PostgreSQL container not running")

    return status


async def check_and_connect() -> DockerPostgresStatus:
    """Check PostgreSQL status and connect if needed.

    This is a convenience function that wraps auto_connect with
    default settings for quick status checks.

    Returns:
        DockerPostgresStatus with connection details
    """
    return await auto_connect(
        start_if_stopped=True,
        wait_for_healthy=True,
        run_migrations_flag=False,
        set_env=True,
    )


async def main():
    """CLI entry point for Docker auto-connect."""
    import sys

    if len(sys.argv) > 1:
        command = sys.argv[1]

        if command == "status":
            status = await check_docker_postgres_running()
            print(f"Running: {status['running']}")
            print(f"Healthy: {status['healthy']}")
            print(f"Status: {status.get('status', 'unknown')}")
            sys.exit(0 if status["healthy"] else 1)

        elif command == "start":
            result = await start_postgres_container()
            print(f"Success: {result['success']}")
            if result['success']:
                print("Container started")
            else:
                print(f"Error: {result.get('error')}")
                sys.exit(1)

        elif command == "wait":
            health = await wait_for_health()
            print(f"Healthy: {health['healthy']}")
            print(f"Elapsed: {health['elapsed']}s")
            sys.exit(0 if health["healthy"] else 1)

        elif command == "connect":
            status = await check_and_connect()
            print(f"Connected: {status.database_reachable}")
            sys.exit(0 if status.database_reachable else 1)

    # Default: run full auto_connect
    status = await auto_connect(verbose=True)
    sys.exit(0 if status.database_reachable else 1)


if __name__ == "__main__":
    asyncio.run(main())
