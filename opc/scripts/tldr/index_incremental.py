#!/usr/bin/env python3
"""Fast incremental indexer for SessionStart hook.

This script is called by the SessionStart hook and must:
1. Check checkpoint quickly (< 100ms)
2. If no new files, exit immediately
3. If new files found, process them (target < 5s for 5 files)
4. Never block Claude startup

Environment Variables:
    TEMPORAL_CHECKPOINT_PATH: Override default checkpoint path
    TEMPORAL_PROJECTS_DIR: Override default projects directory
    TLDR_INDEX_DB: Override TLDR index database path
    CLAUDE_PROJECT_DIR: Project directory for symbol indexing

Usage:
    python index_incremental.py [--dry-run]
    python index_incremental.py --hook  # Background mode for Claude hook
    python index_incremental.py --tldr  # Run TLDR symbol indexing
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from typing import Any

# Default paths - can be overridden by env vars
DEFAULT_CHECKPOINT_PATH = Path.home() / ".claude/cache/temporal-memory/checkpoint.json"
DEFAULT_PROJECTS_DIR = Path.home() / ".claude/projects"
DEFAULT_TLDR_INDEX_DB = Path.home() / ".claude" / "cache" / "tldr-index.db"

# Add scripts directory to path for imports
_SCRIPT_DIR = Path(__file__).parent.parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))


def get_checkpoint_path() -> Path:
    """Get checkpoint path from env or default."""
    env_path = os.environ.get("TEMPORAL_CHECKPOINT_PATH")
    if env_path:
        return Path(env_path)
    return DEFAULT_CHECKPOINT_PATH


def get_projects_dir() -> Path:
    """Get projects directory from env or default."""
    env_path = os.environ.get("TEMPORAL_PROJECTS_DIR")
    if env_path:
        return Path(env_path)
    return DEFAULT_PROJECTS_DIR


def get_tldr_index_db() -> Path:
    """Get TLDR index database path."""
    env_path = os.environ.get("TLDR_INDEX_DB")
    if env_path:
        return Path(env_path)
    return DEFAULT_TLDR_INDEX_DB


def get_project_dir() -> Path:
    """Get project directory from env or default."""
    env_path = os.environ.get("CLAUDE_PROJECT_DIR")
    if env_path:
        return Path(env_path)
    return Path.cwd()


def quick_check(
    checkpoint_path: Path | None = None,
    projects_dir: Path | None = None,
) -> bool:
    """Return True if there are new files to index.

    This function must be FAST (< 100ms) as it runs on every session start.
    Only does lightweight file stat comparisons, no heavy imports.

    Args:
        checkpoint_path: Path to checkpoint JSON file
        projects_dir: Directory containing JSONL project files

    Returns:
        True if there are new/modified files to index, False otherwise
    """
    if checkpoint_path is None:
        checkpoint_path = get_checkpoint_path()
    if projects_dir is None:
        projects_dir = get_projects_dir()

    # First run - no checkpoint exists
    if not checkpoint_path.exists():
        return True

    # Load checkpoint
    try:
        with open(checkpoint_path) as f:
            checkpoint: dict[str, Any] = json.load(f)
    except (json.JSONDecodeError, OSError):
        # Corrupted or unreadable - need to reindex
        return True

    indexed_files: dict[str, dict[str, float]] = checkpoint.get("files", {})

    # Check for new or modified files
    if not projects_dir.exists():
        return False

    # Scan for JSONL files
    for jsonl_file in projects_dir.glob("**/*.jsonl"):
        file_path_str = str(jsonl_file)

        # New file not in checkpoint
        if file_path_str not in indexed_files:
            return True

        # Check if modified (compare mtime and size)
        try:
            stat = jsonl_file.stat()
            indexed = indexed_files[file_path_str]

            if stat.st_mtime != indexed.get("mtime"):
                return True
            if stat.st_size != indexed.get("size"):
                return True
        except OSError:
            # Can't stat file - skip it
            continue

    return False


def _get_current_commit() -> str | None:
    """Get the current git commit hash."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(get_project_dir()),
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            return result.stdout.strip()
    except (subprocess.SubprocessError, FileNotFoundError):
        pass
    return None


def _get_modified_files(commit: str) -> list[str]:
    """Get files modified since a given commit."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", commit],
            cwd=str(get_project_dir()),
            capture_output=True,
            text=True,
            timeout=10
        )
        if result.returncode == 0:
            return [f.strip() for f in result.stdout.strip().split("\n") if f.strip()]
    except (subprocess.SubprocessError, FileNotFoundError):
        pass
    return []


def _get_file_hash(file_path: str) -> str:
    """Get MD5 hash of a file."""
    import hashlib
    try:
        with open(file_path, "rb") as f:
            return hashlib.md5(f.read()).hexdigest()
    except OSError:
        return ""


def _run_tldr_indexer(dry_run: bool = False) -> None:
    """Run the TLDR symbol indexer.

    Args:
        dry_run: If True, check but don't index
    """
    from scripts.tldr.index_db import TldrIndexDb, DatabaseConnection, FileIndexState, IndexState

    project_dir = get_project_dir()
    db_path = get_tldr_index_db()
    project_path = str(project_dir.resolve())

    # Initialize database
    index_db = TldrIndexDb(DatabaseConnection(db_path))

    # Get current state
    current_commit = _get_current_commit()
    state = index_db.get_index_state()

    if state and state.last_commit and state.last_commit == current_commit:
        # No changes since last index
        print(f"TLDR index up to date (commit: {current_commit[:8] if current_commit else 'unknown'})", file=sys.stderr)
        index_db.close()
        return

    last_commit = state.last_commit if state else None

    if dry_run:
        print(f"Dry run: would index from {last_commit[:8] if last_commit else 'initial'} to {current_commit[:8] if current_commit else 'unknown'}", file=sys.stderr)
        index_db.close()
        return

    # Get modified files
    if last_commit:
        modified_files = _get_modified_files(last_commit)
    else:
        # Full reindex needed - all files
        modified_files = []

    print(f"TLDR: Current commit: {current_commit[:8] if current_commit else 'unknown'}", file=sys.stderr)
    print(f"TLDR: Modified files: {len(modified_files)}", file=sys.stderr)

    # Index modified files
    from scripts.tldr.tldr_api import scan_project_files, extract_file

    all_files = scan_project_files(str(project_dir))
    symbol_count = 0
    indexed_files = 0

    for file_path in all_files:
        file_path_obj = Path(file_path)
        rel_path = str(file_path_obj.resolve())

        # Check if file needs indexing
        needs_index = False
        if modified_files:
            # Only index modified files
            for mod in modified_files:
                if rel_path.endswith(mod):
                    needs_index = True
                    break
        else:
            # Full index or file not in DB
            needs_index = True

        if not needs_index:
            continue

        # Get file hash
        file_hash = _get_file_hash(file_path)

        # Extract symbols
        try:
            result = extract_file(file_path)
            symbols = len(result.get("functions", [])) + len(result.get("classes", []))
            symbol_count += symbols
            indexed_files += 1

            # Update database
            file_state = FileIndexState(
                project_path=project_path,
                file_path=rel_path,
                file_hash=file_hash,
                last_indexed_commit=current_commit,
            )
            index_db.set_file_state(file_state)
        except Exception as e:
            print(f"Warning: could not index {file_path}: {e}", file=sys.stderr)

    # Update global state
    new_state = IndexState(
        last_commit=current_commit,
        last_indexed_at=datetime.now(),
        total_files=indexed_files,
        total_symbols=symbol_count
    )
    index_db.set_index_state(new_state)

    print(f"TLDR: Indexed {symbol_count} symbols from {indexed_files} files", file=sys.stderr)

    index_db.close()


def _run_indexer(dry_run: bool = False, timeout: int = 10) -> None:
    """Run the indexer logic.

    Args:
        dry_run: If True, check for new files but don't process
        timeout: Maximum seconds to spend indexing

    Note:
        This function may raise exceptions - caller should handle them.
    """
    start = time.time()

    # Fast path: check if anything to do before heavy imports
    if not quick_check():
        # Nothing to do - exit fast
        return

    if dry_run:
        print("Dry run: new files detected, would process", file=sys.stderr)
        return

    # Only import heavy modules if needed
    try:
        from scripts.backfill_temporal import backfill_incremental

        backfill_incremental(quiet=True, timeout=timeout)
    except ImportError as e:
        # Backfill module not available - not fatal
        print(f"Index skip (module not ready): {e}", file=sys.stderr)

    elapsed = time.time() - start
    if elapsed > 2:
        print(f"Warning: indexing took {elapsed:.1f}s", file=sys.stderr)


def main() -> None:
    """Main entry point for incremental indexer.

    This function NEVER raises exceptions or returns non-zero exit codes
    because it must never block Claude startup.
    """
    parser = argparse.ArgumentParser(description="Fast incremental indexer")
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Check for new files but don't process them",
    )
    parser.add_argument(
        "--timeout",
        type=int,
        default=10,
        help="Maximum time to spend indexing (default: 10s)",
    )
    parser.add_argument(
        "--hook",
        action="store_true",
        help="Hook mode: background self, return immediately (replaces index-sessions.sh)",
    )
    parser.add_argument(
        "--tldr",
        action="store_true",
        help="Run TLDR symbol indexing instead of temporal indexing",
    )

    try:
        args = parser.parse_args()

        if args.tldr:
            # Run TLDR symbol indexer
            _run_tldr_indexer(dry_run=args.dry_run)
            return

        if args.hook:
            # Hook mode: spawn background process and return immediately
            # This replaces index-sessions.sh behavior
            script_path = Path(__file__).resolve()

            # Spawn detached subprocess (no --hook flag = runs normally)
            if sys.platform == "win32":
                # Windows: use CREATE_NEW_PROCESS_GROUP
                subprocess.Popen(
                    [sys.executable, str(script_path), f"--timeout={args.timeout}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    creationflags=subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.DETACHED_PROCESS,
                )
            else:
                # Unix: use nohup-like behavior via start_new_session
                subprocess.Popen(
                    [sys.executable, str(script_path), f"--timeout={args.timeout}"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    start_new_session=True,
                )

            # Return immediately (hook must not block)
            return

        _run_indexer(dry_run=args.dry_run, timeout=args.timeout)
    except Exception as e:  # noqa: BLE001
        # Catch-all: never block Claude startup
        print(f"Index error (non-fatal): {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
