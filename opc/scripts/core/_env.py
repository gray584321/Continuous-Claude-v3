"""Unified environment loading for OPC scripts.

Loads .env files in correct precedence order and provides project path resolution.

Environment Loading Order (later overrides earlier):
1. ~/.claude/.env - User settings (API keys, preferences)
2. .env - Local project overrides
3. opc/.env - Project defaults (if running from parent repo)

Usage:
    from scripts.core._env import setup_environment, OPC_DIR
    setup_environment()
"""
from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import Optional

# Global OPC_DIR - set by setup_environment()
OPC_DIR: Optional[Path] = None


def _get_opc_dir_from_file(file: Path = Path(__file__)) -> Path:
    """Locate opc/ directory reliably from script location.

    Args:
        file: Path to this file (defaults to _env.py)

    Returns:
        Path to opc/ directory
    """
    opc = file.resolve().parent.parent  # scripts/core/ → opc/

    # Validate project structure
    markers = ["pyproject.toml", "scripts"]
    for marker in markers:
        if not (opc / marker).exists():
            raise RuntimeError(
                f"Cannot locate valid OPC project from {file}. "
                f"Missing {marker} in {opc}. "
                f"Please run from the opc/ directory or set CLAUDE_OPC_DIR."
            )

    return opc


def setup_environment(claude_project_dir: Optional[str] = None) -> Path:
    """Load .env files and setup Python path for OPC imports.

    Environment precedence (later overrides):
    1. ~/.claude/.env - User settings (API keys, credentials)
    2. Local .env - Local overrides (CLAUDE_OPC_DIR, etc)
    3. opc/.env - Project defaults

    Args:
        claude_project_dir: Optional CLAUDE_PROJECT_DIR env override

    Returns:
        Path to opc/ directory
    """
    from dotenv import load_dotenv

    global OPC_DIR

    # Determine OPC directory
    if claude_project_dir:
        OPC_DIR = Path(claude_project_dir).resolve()
    else:
        OPC_DIR = _get_opc_dir_from_file(Path(__file__))

    # Add opc/ to Python path for imports like `from scripts.core.db import ...`
    if str(OPC_DIR) not in sys.path:
        sys.path.insert(0, str(OPC_DIR))

    # Load environment files in precedence order
    env_paths = [
        Path.home() / ".claude" / ".env",  # User settings
        Path.cwd() / ".env",               # Local overrides
        OPC_DIR / ".env",                  # Project defaults
    ]

    for env_path in env_paths:
        if env_path.exists():
            load_dotenv(env_path, override=True)

    return OPC_DIR


def require_opc_dir() -> Path:
    """Get OPC_DIR, raising if not initialized.

    Call setup_environment() first if needed.
    """
    global OPC_DIR
    if OPC_DIR is None:
        OPC_DIR = _get_opc_dir_from_file(Path(__file__))
        if str(OPC_DIR) not in sys.path:
            sys.path.insert(0, str(OPC_DIR))
        # Also load env vars
        from dotenv import load_dotenv
        for env_path in [
            Path.home() / ".claude" / ".env",
            Path.cwd() / ".env",
            OPC_DIR / ".env",
        ]:
            if env_path.exists():
                load_dotenv(env_path, override=True)
    return OPC_DIR
