#!/usr/bin/env python3
"""Startup Hook: Docker PostgreSQL Auto-Connect.

This hook is triggered on Claude Code startup to ensure PostgreSQL is available.
It checks if the Docker PostgreSQL container is running, starts it if needed,
and verifies the database connection.

USAGE:
    # Run directly (verbose)
    python -m scripts.hooks.docker_startup

    # Run silently (for SessionStart hook)
    python -m scripts.hooks.docker_startup --silent

    # Or import as module
    from scripts.hooks.docker_startup import run_startup_check
    result = await run_startup_check()
"""

import asyncio
import json
import os
import sys
from pathlib import Path

# Ensure project root is in sys.path
_this_file = Path(__file__).resolve()
_project_root = _this_file.parent.parent.parent  # scripts/hooks/ -> scripts/ -> opc/
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))

try:
    from rich.console import Console
    from rich.panel import Panel
    from rich.text import Text

    console = Console()
except ImportError:

    class Console:
        def print(self, *args, **kwargs):
            print(*args)

    console = Console()


# Paths
PROJECT_ROOT = Path(__file__).parent.parent.parent
ENV_FILE = PROJECT_ROOT / ".env"
# Export file for cross-process coordination (e.g., from different terminals)
EXPORT_FILE = PROJECT_ROOT / ".env.exported.json"


async def check_daemon_running() -> bool:
    """Check if Docker daemon is running."""
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "info",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        return proc.returncode == 0
    except FileNotFoundError:
        return False


async def check_container_status() -> dict[str, Any]:
    """Check the status of the OPC PostgreSQL container."""
    result = {
        "running": False,
        "healthy": False,
        "container_name": "continuous-claude-postgres",
        "message": "",
    }

    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "ps",
            "--filter",
            "name=continuous-claude-postgres",
            "--format",
            "{{.Names}} {{.Status}}",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()

        if proc.returncode == 0 and stdout.decode().strip():
            output = stdout.decode().strip()
            # Parse: "continuous-claude-postgres Up 8 hours (healthy)"
            parts = output.split(" ", 1)
            result["container_name"] = parts[0] if parts else "continuous-claude-postgres"
            status_str = parts[1] if len(parts) > 1 else ""
            result["running"] = "up" in status_str.lower()
            result["message"] = status_str
            result["healthy"] = "(healthy)" in status_str.lower()
        else:
            result["message"] = "not found"

    except Exception as e:
        result["message"] = f"error: {e}"

    return result


async def start_container() -> dict[str, Any]:
    """Start the PostgreSQL container."""
    result = {"success": False, "message": ""}

    try:
        compose_file = PROJECT_ROOT.parent / "docker" / "docker-compose.yml"

        if not compose_file.exists():
            result["message"] = f"docker-compose.yml not found at {compose_file}"
            return result

        proc = await asyncio.create_subprocess_exec(
            "docker",
            "compose",
            "-f",
            str(compose_file),
            "up",
            "-d",
            "postgres",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await proc.communicate()

        if proc.returncode == 0:
            result["success"] = True
            result["message"] = "Container started"
        else:
            result["message"] = stderr.decode().strip() or "Failed to start container"

    except Exception as e:
        result["message"] = str(e)

    return result


async def wait_for_healthy(timeout: int = 60) -> bool:
    """Wait for PostgreSQL container to be healthy."""
    compose_file = PROJECT_ROOT.parent / "docker" / "docker-compose.yml"

    start_time = asyncio.get_event_loop().time()

    while (asyncio.get_event_loop().time() - start_time) < timeout:
        try:
            proc = await asyncio.create_subprocess_exec(
                "docker",
                "compose",
                "-f",
                str(compose_file),
                "ps",
                "postgres",
                "--format",
                "{{.Health}}",
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            stdout, _ = await proc.communicate()

            if stdout.decode().strip().lower() == "healthy":
                return True

        except Exception:
            pass

        await asyncio.sleep(1)

    return False


async def detect_database_url() -> str | None:
    """Detect DATABASE_URL from environment or .env file."""
    # Check environment
    if os.environ.get("DATABASE_URL"):
        return os.environ.get("DATABASE_URL")

    # Check .env file
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            if line.startswith("DATABASE_URL="):
                return line.split("=", 1)[1].strip()

    return None


def export_database_url(db_url: str) -> None:
    """Export DATABASE_URL to a JSON file for cross-process coordination.

    This allows other processes (e.g., different terminals) to read the
    DATABASE_URL without parsing the .env file directly.
    """
    try:
        export_data = {
            "DATABASE_URL": db_url,
            "exported_at": asyncio.get_event_loop().time(),
        }
        EXPORT_FILE.write_text(json.dumps(export_data, indent=2))
    except Exception:
        pass  # Silently fail if we can't write export file


async def ensure_database_url() -> bool:
    """Ensure DATABASE_URL is set in environment and .env file."""
    db_url = await detect_database_url()

    if db_url:
        os.environ["DATABASE_URL"] = db_url
        export_database_url(db_url)
        return True

    # Generate default URL if we can connect to container
    try:
        proc = await asyncio.create_subprocess_exec(
            "docker",
            "exec",
            "continuous-claude-postgres",
            "env",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, _ = await proc.communicate()
        env_output = stdout.decode()

        if proc.returncode == 0:
            # Parse PostgreSQL environment variables
            env_vars = {}
            for line in env_output.strip().split("\n"):
                if "=" in line:
                    key, value = line.split("=", 1)
                    env_vars[key] = value

            # Generate URL from container environment
            host = env_vars.get("POSTGRES_HOST", "localhost")
            port = env_vars.get("POSTGRES_PORT", "5432")
            database = env_vars.get("POSTGRES_DB", "continuous_claude")
            user = env_vars.get("POSTGRES_USER", "claude")
            password = env_vars.get("POSTGRES_PASSWORD", "claude_dev")

            db_url = f"postgresql://{user}:{password}@{host}:{port}/{database}"
            os.environ["DATABASE_URL"] = db_url

            # Update .env file
            if ENV_FILE.exists():
                content = ENV_FILE.read_text()
                if "DATABASE_URL=" in content:
                    # Replace existing
                    lines = content.split("\n")
                    new_lines = []
                    for line in lines:
                        if line.startswith("DATABASE_URL="):
                            new_lines.append(f"DATABASE_URL={db_url}")
                        else:
                            new_lines.append(line)
                    ENV_FILE.write_text("\n".join(new_lines))
                else:
                    # Append
                    ENV_FILE.write_text(content + f"\nDATABASE_URL={db_url}\n")
            else:
                ENV_FILE.write_text(f"DATABASE_URL={db_url}\n")

            return True

    except Exception:
        pass

    return False


async def run_startup_check(
    auto_start: bool = True,
    verbose: bool = False,
    silent: bool = False,
) -> dict[str, Any]:
    """Run the startup check for PostgreSQL.

    Args:
        auto_start: Automatically start container if not running
        verbose: Show detailed output
        silent: Run silently, don't print anything (for SessionStart hook)

    Returns:
        dict with status information
    """
    result = {
        "daemon_running": False,
        "container_running": False,
        "container_healthy": False,
        "database_url_set": False,
        "actions_taken": [],
        "ready": False,
        "error": None,
    }

    # Check Docker daemon
    daemon_running = await check_daemon_running()
    result["daemon_running"] = daemon_running

    if not daemon_running:
        result["error"] = "Docker daemon not running"
        if verbose and not silent:
            console.print(f"  [yellow]WARN[/yellow] Docker daemon not running")
        return result

    if verbose and not silent:
        console.print("  [green]OK[/green] Docker daemon running")

    # Check container status
    container_status = await check_container_status()
    result["container_running"] = container_status["running"]

    if container_status["running"]:
        if verbose and not silent:
            console.print(f"  [green]OK[/green] Container: {container_status['message']}")
        result["container_healthy"] = container_status["healthy"]
    else:
        if verbose and not silent:
            console.print(f"  [yellow]WARN[/yellow] Container: {container_status['message']}")

        if auto_start:
            if verbose and not silent:
                console.print("  Starting container...")
            start_result = await start_container()
            if start_result["success"]:
                result["actions_taken"].append("started_container")
                result["container_running"] = True
                if verbose and not silent:
                    console.print("  [green]OK[/green] Container started")
            else:
                result["error"] = start_result["message"]
                return result
        else:
            result["error"] = "Container not running"
            return result

    # Wait for healthy if started but not healthy
    if result["container_running"] and not result["container_healthy"]:
        if verbose and not silent:
            console.print("  Waiting for PostgreSQL to be ready...")
        healthy = await wait_for_healthy(timeout=60)
        result["container_healthy"] = healthy

        if healthy:
            result["actions_taken"].append("waited_for_healthy")
            if verbose and not silent:
                console.print("  [green]OK[/green] PostgreSQL is ready")
        else:
            result["error"] = "PostgreSQL did not become healthy in time"
            return result

    # Ensure DATABASE_URL is set
    db_url_set = await ensure_database_url()
    result["database_url_set"] = db_url_set

    if db_url_set:
        result["ready"] = True
        if verbose and not silent:
            console.print("  [green]OK[/green] DATABASE_URL configured")
    else:
        result["error"] = "Could not configure DATABASE_URL"

    return result


def print_startup_status(result: dict[str, Any]) -> None:
    """Print a formatted startup status."""
    panel = Panel(
        Text.from_markup(
            f"""[bold]Docker PostgreSQL Status[/bold]

  Daemon:      {'[green]Running[/green]' if result['daemon_running'] else '[red]Not Running[/red]'}
  Container:   {'[green]Running[/green]' if result['container_running'] else '[red]Stopped[/red]'}
  Database:    {'[green]Ready[/green]' if result['ready'] else '[yellow]Not Ready[/yellow]'}
  DATABASE_URL:{'[green]Set[/green]' if result['database_url_set'] else '[red]Not Set[/red]'}

  Actions: {', '.join(result['actions_taken']) if result['actions_taken'] else 'none'}
  Error: {result['error'] or 'none'}""",
            justify="left",
        ),
        title="Startup Check",
        border_style="blue",
    )
    console.print(panel)


async def main():
    """Main entry point."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Check and ensure PostgreSQL Docker container is running"
    )
    parser.add_argument(
        "--verbose", "-v", action="store_true", help="Show detailed output"
    )
    parser.add_argument(
        "--silent", "-s", action="store_true",
        help="Run silently, only export DATABASE_URL (for SessionStart hook)"
    )
    parser.add_argument(
        "--no-auto-start",
        action="store_true",
        help="Do not automatically start container",
    )
    parser.add_argument(
        "--status-only", action="store_true", help="Only show status, don't start"
    )

    args = parser.parse_args()

    # Silent mode implies no auto-start and no output
    if args.silent:
        result = await run_startup_check(auto_start=False, verbose=False, silent=True)
        # Always exit 0 in silent mode - don't block Claude Code startup
        sys.exit(0)

    if args.status_only:
        result = await run_startup_check(auto_start=False, verbose=True)
    else:
        result = await run_startup_check(
            auto_start=not args.no_auto_start, verbose=args.verbose
        )

    print_startup_status(result)

    # Exit with appropriate code
    if result["ready"]:
        sys.exit(0)
    elif result["error"] and "not running" in result["error"].lower():
        sys.exit(10)  # Docker not running
    elif result["error"] and "container" in result["error"].lower():
        sys.exit(11)  # Container issue
    else:
        sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
