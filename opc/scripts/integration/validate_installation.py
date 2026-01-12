#!/usr/bin/env python3
"""
Manual Validation Script for Continuous-Claude-v3 Installation.

Runs all validation checks and reports status with actionable recommendations.

Usage:
    python scripts/integration/validate_installation.py
    python scripts/integration/validate_installation.py --json
    python scripts/integration/validate_installation.py --component database
    python scripts/integration/validate_installation.py --fix
"""

import argparse
import asyncio
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any

# Add project root to path
_project_root = Path(__file__).parent.parent.parent
sys.path.insert(0, str(_project_root))


# =============================================================================
# Configuration
# =============================================================================

CHECK_TIMEOUT = 30  # seconds


# =============================================================================
# Enums and Data Classes
# =============================================================================


class CheckStatus(Enum):
    """Status of a validation check."""
    PASS = "PASS"
    FAIL = "FAIL"
    WARN = "WARN"
    SKIP = "SKIP"


class Component(Enum):
    """System components for validation."""
    DATABASE = "database"
    WIZARD = "wizard"
    TLDR = "tldr"
    HOOKS = "hooks"
    HEALTH = "health"


@dataclass
class ValidationCheck:
    """A single validation check."""
    name: str
    component: Component
    status: CheckStatus = CheckStatus.SKIP
    message: str = ""
    details: dict[str, Any] = field(default_factory=dict)
    fix_command: str | None = None


@dataclass
class ValidationResult:
    """Results from all validation checks."""
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    checks: list[ValidationCheck] = field(default_factory=list)
    components_checked: set[Component] = field(default_factory=set)

    @property
    def all_passed(self) -> bool:
        return all(c.status in [CheckStatus.PASS, CheckStatus.WARN, CheckStatus.SKIP]
                   for c in self.checks)

    @property
    def passed_count(self) -> int:
        return sum(1 for c in self.checks if c.status == CheckStatus.PASS)

    @property
    def failed_count(self) -> int:
        return sum(1 for c in self.checks if c.status == CheckStatus.FAIL)

    @property
    def warning_count(self) -> int:
        return sum(1 for c in self.checks if c.status == CheckStatus.WARN)

    @property
    def skipped_count(self) -> int:
        return sum(1 for c in self.checks if c.status == CheckStatus.SKIP)


# =============================================================================
# Utility Functions
# =============================================================================


def run_command(
    cmd: list[str],
    timeout: int = CHECK_TIMEOUT,
    cwd: Path | None = None,
) -> tuple[int, str, str]:
    """Run a command and return exit code, stdout, stderr."""
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=cwd,
        )
        return result.returncode, result.stdout, result.stderr
    except subprocess.TimeoutExpired:
        return -1, "", "Command timed out"
    except FileNotFoundError:
        return -1, "", f"Command not found: {cmd[0]}"
    except Exception as e:
        return -1, "", str(e)


def check_file_exists(path: Path) -> bool:
    """Check if a file exists."""
    return path.exists() and path.is_file()


def check_dir_exists(path: Path) -> bool:
    """Check if a directory exists."""
    return path.exists() and path.is_dir()


# =============================================================================
# Check Functions
# =============================================================================


def check_python_version() -> ValidationCheck:
    """Check Python version."""
    check = ValidationCheck(
        name="Python Version",
        component=Component.HEALTH,
    )

    version = sys.version_info
    if version.major >= 3 and version.minor >= 11:
        check.status = CheckStatus.PASS
        check.message = f"Python {version.major}.{version.minor}.{version.micro}"
    else:
        check.status = CheckStatus.FAIL
        check.message = f"Python {version.major}.{version.minor} - requires 3.11+"
        check.fix_command = "Install Python 3.11+ from https://python.org"

    return check


def check_uv_installed() -> ValidationCheck:
    """Check if uv is installed."""
    check = ValidationCheck(
        name="UV Package Manager",
        component=Component.HEALTH,
    )

    uv_path = shutil.which("uv")
    if uv_path:
        check.status = CheckStatus.PASS
        check.message = f"UV found at {uv_path}"
    else:
        check.status = CheckStatus.FAIL
        check.message = "UV not found in PATH"
        check.fix_command = "curl -LsSf https://astral.sh/uv/install.sh | sh"

    return check


def check_opc_dependencies() -> ValidationCheck:
    """Check if OPC dependencies are installed."""
    check = ValidationCheck(
        name="OPC Dependencies",
        component=Component.HEALTH,
    )

    opc_dir = _project_root / "opc"
    pyproject = opc_dir / "pyproject.toml"

    if not pyproject.exists():
        check.status = CheckStatus.FAIL
        check.message = "pyproject.toml not found"
        return check

    # Check if .venv exists or uv can create it
    venv_dir = opc_dir / ".venv"
    if venv_dir.exists():
        check.status = CheckStatus.PASS
        check.message = "Virtual environment exists"
    else:
        check.status = CheckStatus.WARN
        check.message = "Virtual environment not created"
        check.fix_command = "cd opc && uv sync"

    return check


def check_database_connection() -> ValidationCheck:
    """Check PostgreSQL connection."""
    check = ValidationCheck(
        name="Database Connection",
        component=Component.DATABASE,
    )

    # Check DATABASE_URL env var
    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        check.status = CheckStatus.WARN
        check.message = "DATABASE_URL not set"
        check.fix_command = "Run: source .env"
        return check

    # Try to connect using psql
    code, stdout, stderr = run_command([
        "psql", db_url, "-c", "SELECT 1;", "-t"
    ])

    if code == 0:
        check.status = CheckStatus.PASS
        check.message = "PostgreSQL connection successful"
    else:
        check.status = CheckStatus.FAIL
        check.message = f"PostgreSQL connection failed: {stderr or stdout}"
        check.fix_command = "Check DATABASE_URL or run: docker compose up -d"

    return check


def check_database_schema() -> ValidationCheck:
    """Check database schema is correct."""
    check = ValidationCheck(
        name="Database Schema",
        component=Component.DATABASE,
    )

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        check.status = CheckStatus.SKIP
        check.message = "DATABASE_URL not set"
        return check

    # Check for required tables
    tables = ["sessions", "file_claims", "archival_memory", "handoffs"]
    missing_tables = []

    for table in tables:
        code, stdout, stderr = run_command([
            "psql", db_url, "-c",
            f"SELECT to_regclass('public.{table}');", "-t"
        ])
        if code != 0 or "regclass" in stderr.lower():
            missing_tables.append(table)

    if not missing_tables:
        check.status = CheckStatus.PASS
        check.message = "All required tables exist"
    else:
        check.status = CheckStatus.FAIL
        check.message = f"Missing tables: {', '.join(missing_tables)}"
        check.fix_command = "Run: python -m scripts.setup.docker_setup migrate"

    return check


def check_pgvector() -> ValidationCheck:
    """Check pgvector extension."""
    check = ValidationCheck(
        name="pgvector Extension",
        component=Component.DATABASE,
    )

    db_url = os.environ.get("DATABASE_URL")
    if not db_url:
        check.status = CheckStatus.SKIP
        check.message = "DATABASE_URL not set"
        return check

    code, stdout, stderr = run_command([
        "psql", db_url, "-c", "SELECT 1 FROM pg_extension WHERE extname = 'vector';", "-t"
    ])

    if code == 0 and stdout.strip():
        check.status = CheckStatus.PASS
        check.message = "pgvector extension enabled"
    else:
        check.status = CheckStatus.FAIL
        check.message = "pgvector extension not enabled"
        check.fix_command = "Run: CREATE EXTENSION IF NOT EXISTS vector;"

    return check


def check_wizard_installed() -> ValidationCheck:
    """Check wizard script exists."""
    check = ValidationCheck(
        name="Wizard Script",
        component=Component.WIZARD,
    )

    wizard_path = _project_root / "opc" / "scripts" / "setup" / "wizard.py"

    if check_file_exists(wizard_path):
        check.status = CheckStatus.PASS
        check.message = f"Wizard found at {wizard_path}"
    else:
        check.status = CheckStatus.FAIL
        check.message = f"Wizard not found at {wizard_path}"

    return check


def check_claude_home() -> ValidationCheck:
    """Check ~/.claude directory."""
    check = ValidationCheck(
        name="Claude Home Directory",
        component=Component.WIZARD,
    )

    claude_home = Path.home() / ".claude"

    if check_dir_exists(claude_home):
        check.status = CheckStatus.PASS
        check.message = str(claude_home)
    else:
        check.status = CheckStatus.WARN
        check.message = "~/.claude not found"
        check.fix_command = "Run: python -m scripts.setup.wizard"

    return check


def check_hooks_dist() -> ValidationCheck:
    """Check hooks/dist directory exists."""
    check = ValidationCheck(
        name="Built Hooks",
        component=Component.HOOKS,
    )

    hooks_dist = Path.home() / ".claude" / "hooks" / "dist"

    if check_dir_exists(hooks_dist):
        hook_count = len(list(hooks_dist.glob("*.mjs")))
        if hook_count > 0:
            check.status = CheckStatus.PASS
            check.message = f"{hook_count} hooks built"
        else:
            check.status = CheckStatus.WARN
            check.message = "hooks/dist exists but no .mjs files"
            check.fix_command = "Run: cd ~/.claude/hooks && npm install && npm run build"
    else:
        check.status = CheckStatus.FAIL
        check.message = "hooks/dist not found"
        check.fix_command = "Run: python -m scripts.setup.wizard"

    return check


def check_skills_installed() -> ValidationCheck:
    """Check skills are installed."""
    check = ValidationCheck(
        name="Skills Installed",
        component=Component.HOOKS,
    )

    skills_dir = Path.home() / ".claude" / "skills"

    if check_dir_exists(skills_dir):
        skill_count = len([d for d in skills_dir.iterdir() if d.is_dir()])
        if skill_count > 0:
            check.status = CheckStatus.PASS
            check.message = f"{skill_count} skills installed"
        else:
            check.status = CheckStatus.WARN
            check.message = "skills directory empty"
    else:
        check.status = CheckStatus.FAIL
        check.message = "skills directory not found"

    return check


def check_rules_installed() -> ValidationCheck:
    """Check rules are installed."""
    check = ValidationCheck(
        name="Rules Installed",
        component=Component.HOOKS,
    )

    rules_dir = Path.home() / ".claude" / "rules"

    if check_dir_exists(rules_dir):
        rule_count = len(list(rules_dir.glob("*.md")))
        if rule_count > 0:
            check.status = CheckStatus.PASS
            check.message = f"{rule_count} rules installed"
        else:
            check.status = CheckStatus.WARN
            check.message = "rules directory empty"
    else:
        check.status = CheckStatus.FAIL
        check.message = "rules directory not found"

    return check


def check_tldr_installed() -> ValidationCheck:
    """Check TLDR is installed."""
    check = ValidationCheck(
        name="TLDR Installed",
        component=Component.TLDR,
    )

    tldr_path = shutil.which("tldr")
    if tldr_path:
        code, stdout, stderr = run_command(["tldr", "--version"])
        if code == 0:
            check.status = CheckStatus.PASS
            check.message = f"TLDR found at {tldr_path}"
        else:
            check.status = CheckStatus.WARN
            check.message = "TLDR found but version check failed"
    else:
        check.status = CheckStatus.FAIL
        check.message = "TLDR not found in PATH"
        check.fix_command = "pip install llm-tldr"

    return check


def check_symbol_index() -> ValidationCheck:
    """Check symbol index directory."""
    check = ValidationCheck(
        name="Symbol Index",
        component=Component.TLDR,
    )

    index_dir = Path.home() / ".claude" / "cache" / "symbol-index"

    if check_dir_exists(index_dir):
        symbols_file = index_dir / "symbols.json"
        if check_file_exists(symbols_file):
            check.status = CheckStatus.PASS
            check.message = f"Symbol index exists at {symbols_file}"
        else:
            check.status = CheckStatus.WARN
            check.message = "Symbol index directory exists but no symbols.json"
            check.fix_command = "Run: tldr index ."
    else:
        check.status = CheckStatus.WARN
        check.message = "Symbol index not created"
        check.fix_command = "Run: tldr index . or python -m scripts.tldr.build_symbol_index"

    return check


def check_docker_running() -> ValidationCheck:
    """Check Docker is running."""
    check = ValidationCheck(
        name="Docker Running",
        component=Component.DATABASE,
    )

    code, stdout, stderr = run_command(["docker", "info"])
    if code == 0:
        check.status = CheckStatus.PASS
        check.message = "Docker is running"
    else:
        check.status = CheckStatus.WARN
        check.message = "Docker not running or not available"
        check.fix_command = "Start Docker Desktop or run: sudo systemctl start docker"

    return check


def check_health_checks() -> ValidationCheck:
    """Run health checks."""
    check = ValidationCheck(
        name="Health Checks",
        component=Component.HEALTH,
    )

    try:
        from scripts.core.health_check import HealthCheck, HealthStatus

        hc = HealthCheck()
        report = hc.check_all()

        if report.overall_status == HealthStatus.HEALTHY:
            check.status = CheckStatus.PASS
            check.message = "All health checks passed"
        elif report.overall_status == HealthStatus.DEGRADED:
            check.status = CheckStatus.WARN
            check.message = "Some health checks degraded"
        else:
            check.status = CheckStatus.FAIL
            check.message = "Health checks failed"

        check.details = {
            "overall_status": report.overall_status.value,
            "check_count": len(report.checks),
        }
    except Exception as e:
        check.status = CheckStatus.FAIL
        check.message = f"Health check error: {e}"

    return check


# =============================================================================
# Validation Runner
# =============================================================================


def run_all_checks(components: list[Component] | None = None) -> ValidationResult:
    """Run all validation checks.

    Args:
        components: Optional list of components to check (defaults to all)

    Returns:
        ValidationResult with all check results
    """
    result = ValidationResult()

    # Define all check functions
    check_functions = [
        check_python_version,
        check_uv_installed,
        check_opc_dependencies,
        check_docker_running,
        check_database_connection,
        check_database_schema,
        check_pgvector,
        check_wizard_installed,
        check_claude_home,
        check_hooks_dist,
        check_skills_installed,
        check_rules_installed,
        check_tldr_installed,
        check_symbol_index,
        check_health_checks,
    ]

    for check_func in check_functions:
        check = check_func()

        if components and check.component not in components:
            continue

        result.checks.append(check)
        result.components_checked.add(check.component)

    return result


def print_result(result: ValidationResult, verbose: bool = False) -> None:
    """Print validation result."""
    print("\n" + "=" * 70)
    print("CONTINUOUS-CLAUDE-V3 VALIDATION REPORT")
    print("=" * 70)
    print(f"Timestamp: {result.timestamp}")
    print(f"Components Checked: {', '.join(c.value for c in result.components_checked)}")
    print()

    # Summary
    print("SUMMARY")
    print("-" * 40)
    print(f"  Passed:   {result.passed_count}")
    print(f"  Failed:   {result.failed_count}")
    print(f"  Warnings: {result.warning_count}")
    print(f"  Skipped:  {result.skipped_count}")
    print()

    # Detailed results
    print("DETAILED RESULTS")
    print("-" * 40)

    status_icons = {
        CheckStatus.PASS: "[OK]",
        CheckStatus.FAIL: "[FAIL]",
        CheckStatus.WARN: "[WARN]",
        CheckStatus.SKIP: "[SKIP]",
    }

    for check in result.checks:
        icon = status_icons.get(check.status, "[?]")
        component = check.component.value.upper()
        print(f"  {icon} [{component}] {check.name}")
        print(f"         {check.message}")

        if verbose and check.details:
            for key, value in check.details.items():
                print(f"         {key}: {value}")

        if check.fix_command and check.status in [CheckStatus.FAIL, CheckStatus.WARN]:
            print(f"         Fix: {check.fix_command}")

        print()

    # Final status
    print("=" * 70)
    if result.all_passed:
        print("[OK] All validation checks passed!")
    else:
        print("[FAIL] Some validation checks failed.")
        print("\nTo fix common issues, run:")
        print("  cd opc && uv sync")
        print("  python -m scripts.setup.wizard --update")
        print("  python -m scripts.setup.docker_setup migrate")
    print("=" * 70)


# =============================================================================
# Main Entry Point
# =============================================================================


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(
        description="Validate Continuous-Claude-v3 installation",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  %(prog)s                     # Run all checks
  %(prog)s --json              # Output as JSON
  %(prog)s --component database  # Only check database
  %(prog)s --verbose           # Verbose output
  %(prog)s --fix               # Attempt automatic fixes
        """,
    )

    parser.add_argument(
        "--component", "-c",
        choices=["database", "wizard", "tldr", "hooks", "health"],
        help="Component to validate",
    )
    parser.add_argument(
        "--json", "-j",
        action="store_true",
        help="Output results as JSON",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Enable verbose output",
    )
    parser.add_argument(
        "--fix",
        action="store_true",
        help="Attempt automatic fixes (not fully implemented)",
    )

    args = parser.parse_args()

    # Determine components to check
    components = None
    if args.component:
        component_map = {
            "database": Component.DATABASE,
            "wizard": Component.WIZARD,
            "tldr": Component.TLDR,
            "hooks": Component.HOOKS,
            "health": Component.HEALTH,
        }
        components = [component_map[args.component]]

    # Run checks
    result = run_all_checks(components)

    # Output
    if args.json:
        # Convert result to dict
        result_dict = {
            "timestamp": result.timestamp,
            "all_passed": result.all_passed,
            "passed": result.passed_count,
            "failed": result.failed_count,
            "warnings": result.warning_count,
            "skipped": result.skipped_count,
            "checks": [
                {
                    "name": c.name,
                    "component": c.component.value,
                    "status": c.status.value,
                    "message": c.message,
                    "details": c.details,
                    "fix_command": c.fix_command,
                }
                for c in result.checks
            ],
        }
        print(json.dumps(result_dict, indent=2))
    else:
        print_result(result, verbose=args.verbose)

    # Return exit code
    return 0 if result.all_passed else 1


if __name__ == "__main__":
    sys.exit(main() or 0)
