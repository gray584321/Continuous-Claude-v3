#!/usr/bin/env python3
"""Store TLDR scan results in the codebase_scans table.

Stores structure and architecture analysis results for semantic retrieval.

Usage:
    uv run python opc/scripts/core/store_codebase_scan.py \
        --session-id "abc123" \
        --scan-type "structure" \
        --project "my-project" \
        --content "$(tldr structure .)" \
        --metadata '{"file_count": 42, "function_count": 156}'

    # Or read from stdin:
    tldr structure . | uv run python opc/scripts/core/store_codebase_scan.py \
        --session-id "abc123" \
        --scan-type "structure" \
        --project "my-project" \
        --content "-"

Environment:
    DATABASE_URL: PostgreSQL connection string
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Setup logging
logger = logging.getLogger(__name__)

# Load global ~/.claude/.env first, then local .env
global_env = Path.home() / ".claude" / ".env"
if global_env.exists():
    load_dotenv(global_env)
load_dotenv()

# Add project to path
project_dir = os.environ.get("CLAUDE_PROJECT_DIR", str(Path(__file__).parent.parent.parent))
sys.path.insert(0, project_dir)

from scripts.core.db.embedding_service import EmbeddingService

# Valid scan types
SCAN_TYPES = ["structure", "arch", "diagnostics", "dead", "imports", "impact", "full"]

# Session ID validation pattern
SESSION_ID_PATTERN = re.compile(r'^[a-zA-Z0-9_-]{1,128}$')

# Content size limit: 10MB
MAX_CONTENT_SIZE = 10 * 1024 * 1024


def validate_session_id(session_id: str) -> tuple[bool, str | None]:
    """Validate session ID format.

    Args:
        session_id: Session identifier to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not session_id:
        return False, "session_id is required"
    if not SESSION_ID_PATTERN.match(session_id):
        return False, "session_id contains invalid characters (only a-z, A-Z, 0-9, _, - allowed)"
    return True, None


def validate_content(content: str) -> tuple[bool, str | None]:
    """Validate content size.

    Args:
        content: Content to validate

    Returns:
        Tuple of (is_valid, error_message)
    """
    if not content or not content.strip():
        return False, "No content provided"
    if len(content) > MAX_CONTENT_SIZE:
        return False, f"Content too large: {len(content)} bytes (max: {MAX_CONTENT_SIZE})"
    return True, None


async def store_codebase_scan(
    session_id: str,
    scan_type: str,
    project: str,
    content: str,
    metadata: dict | None = None,
) -> dict:
    """Store a TLDR scan result in the codebase_scans table.

    Args:
        session_id: Session identifier
        scan_type: Type of scan (structure, arch, diagnostics, dead, imports, impact, full)
        project: Project name
        content: The scan content
        metadata: Additional scan metadata (file counts, etc.)

    Returns:
        dict with success status and scan_id
    """
    try:
        import psycopg2
    except ImportError:
        return {"success": False, "error": "psycopg2 not installed"}

    # Validate session_id
    valid, error = validate_session_id(session_id)
    if not valid:
        return {"success": False, "error": error}

    # Validate scan_type
    if scan_type not in SCAN_TYPES:
        return {
            "success": False,
            "error": f"Invalid scan_type '{scan_type}'. Must be one of: {', '.join(SCAN_TYPES)}",
        }

    # Validate content
    valid, error = validate_content(content)
    if not valid:
        return {"success": False, "error": error}

    # Get database URL
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return {"success": False, "error": "DATABASE_URL not set"}

    conn = None
    cursor = None
    try:
        # Connect to PostgreSQL
        conn = psycopg2.connect(database_url)
        cursor = conn.cursor()

        # Generate embedding
        embedder = EmbeddingService(provider="local")
        embedding = await embedder.embed(content)
        # Clean up embedder
        await embedder.aclose()

        # Prepare metadata JSON
        metadata_json = json.dumps(metadata or {})

        # Insert into codebase_scans
        cursor.execute("""
            INSERT INTO codebase_scans (
                session_id, project, scan_type, content, embedding,
                embedding_model, metadata, created_at
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
            RETURNING id
        """, (
            session_id, project, scan_type, content,
            embedding,  # Already a list[float], not numpy
            'Qwen/Qwen3-Embedding-0.6B',
            metadata_json
        ))

        scan_id = cursor.fetchone()[0]
        conn.commit()

        return {
            "success": True,
            "scan_id": str(scan_id),
            "scan_type": scan_type,
            "project": project,
            "content_length": len(content),
            "embedding_dim": len(embedding),
        }

    except psycopg2.Error as e:
        return {"success": False, "error": str(e)}
    except Exception as e:
        return {"success": False, "error": str(e)}
    finally:
        # Ensure connection is always closed
        if cursor is not None:
            try:
                cursor.close()
            except Exception:
                pass
        if conn is not None:
            try:
                conn.close()
            except Exception:
                pass


async def main():
    parser = argparse.ArgumentParser(description="Store TLDR scan results in codebase_scans")
    parser.add_argument("--session-id", required=True, help="Session identifier")
    parser.add_argument(
        "--scan-type",
        required=True,
        choices=SCAN_TYPES,
        help="Type of scan",
    )
    parser.add_argument("--project", required=True, help="Project name")
    parser.add_argument(
        "--content",
        required=True,
        help="Scan content (or '-' to read from stdin)",
    )
    parser.add_argument(
        "--metadata",
        help="JSON metadata (e.g., '{\"file_count\": 42}')",
    )
    parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    # Read from stdin if content is '-'
    if args.content == "-":
        args.content = sys.stdin.read()

    # Parse metadata
    metadata = None
    if args.metadata:
        try:
            metadata = json.loads(args.metadata)
        except json.JSONDecodeError as e:
            print(f"Invalid JSON metadata: {e}")
            sys.exit(1)

    result = await store_codebase_scan(
        session_id=args.session_id,
        scan_type=args.scan_type,
        project=args.project,
        content=args.content,
        metadata=metadata,
    )

    if args.json:
        print(json.dumps(result))
    else:
        if result["success"]:
            print(f"Scan stored (id: {result.get('scan_id', 'unknown')})")
            print(f"  Type: {result.get('scan_type')}")
            print(f"  Project: {result.get('project')}")
            print(f"  Content: {result.get('content_length', 0)} chars")
        else:
            print(f"Failed to store scan: {result.get('error', 'unknown')}")
            sys.exit(1)


if __name__ == "__main__":
    asyncio.run(main())
