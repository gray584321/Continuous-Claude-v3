"""Database migration manager for tracking and applying schema migrations.

This module provides a MigrationManager class that:
- Discovers migration files from a migrations directory
- Tracks applied migrations in a schema_migrations table
- Supports idempotent migrations (safe to re-run via IF NOT EXISTS)
- Provides basic rollback capability
- Calculates checksums to detect modified migrations

Migration File Naming Convention:
    <3-digit ID>_<description>.sql

    Examples:
        001_create_migrations_table.sql
        002_add_health_check_history.sql
        010_add_user_sessions.sql

Migration File Format:
    -- Migration: <ID>_<name>
    -- Description: <description>
    -- [Optional: Down migration in comments]

    <SQL statements>

    -- Idempotent: Use CREATE TABLE IF NOT EXISTS, etc.
"""

import hashlib
import logging
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from scripts.core.db.postgres_pool import get_connection

logger = logging.getLogger(__name__)

# Default migrations directory relative to opc/scripts/
MIGRATIONS_DIR = Path(__file__).parent / "migrations"


@dataclass
class Migration:
    """Represents a single migration file.

    Attributes:
        id: The 3-digit numeric ID (e.g., "001")
        name: The descriptive name from the filename (e.g., "create_migrations_table")
        path: Path to the migration SQL file
    """

    id: str
    name: str
    path: Path

    @classmethod
    def from_filename(cls, filename: str, migrations_dir: Path | None = None) -> "Migration":
        """Parse a migration filename into its components.

        Args:
            filename: A migration filename like "001_create_migrations_table.sql"
            migrations_dir: Optional directory path to create full path

        Returns:
            A Migration instance with id, name, and path populated.
        """
        # Extract numeric ID and name from filename
        # Pattern: <digits>_<name>.sql
        match = re.match(r"^(\d+)_(.+)\.sql$", filename)
        if not match:
            raise ValueError(f"Invalid migration filename: {filename}")

        id_str = match.group(1).zfill(3)  # Pad to 3 digits
        name = match.group(2)

        if migrations_dir:
            path = migrations_dir / filename
        else:
            path = Path(filename)

        return cls(id=id_str, name=name, path=path)

    def __lt__(self, other: "Migration") -> bool:
        """Compare migrations by their numeric ID."""
        return int(self.id) < int(other.id)

    def __eq__(self, other: object) -> bool:
        """Check equality based on ID and name."""
        if not isinstance(other, Migration):
            return NotImplemented
        return self.id == other.id and self.name == other.name

    def __hash__(self) -> int:
        """Hash based on ID."""
        return hash(self.id)


class MigrationManager:
    """Manages database migrations for the Continuous Claude system.

    The MigrationManager:
    1. Discovers migration files from the migrations directory
    2. Tracks which migrations have been applied in schema_migrations
    3. Applies pending migrations in order
    4. Supports rollback (when implemented in the migration file)

    Usage:
        manager = MigrationManager()
        result = manager.apply_all()

        # Or run specific operations
        applied = manager.get_applied_migrations()
        pending = manager.get_pending_migrations()
    """

    def __init__(
        self,
        migrations_dir: Path | None = None,
    ) -> None:
        """Initialize the migration manager.

        Args:
            migrations_dir: Path to the migrations directory.
                          Defaults to opc/scripts/migrations/
        """
        self.migrations_dir = migrations_dir or MIGRATIONS_DIR
        self._pool = None  # Lazy initialization via get_connection

    def get_migrations(self) -> list[Migration]:
        """Discover all migration files in the migrations directory.

        Returns:
            A sorted list of Migration objects, ordered by ID.
        """
        if not self.migrations_dir.exists():
            logger.warning(
                "Migrations directory does not exist: %s",
                self.migrations_dir,
            )
            return []

        migrations: list[Migration] = []
        for filepath in self.migrations_dir.glob("*.sql"):
            try:
                migration = Migration.from_filename(filepath.name, self.migrations_dir)
                migrations.append(migration)
            except ValueError as e:
                logger.warning("Skipping invalid migration file: %s - %s", filepath, e)

        return sorted(migrations)

    def _calculate_checksum(self, migration: Migration) -> str:
        """Calculate SHA-256 checksum of a migration file.

        Args:
            migration: The migration to checksum.

        Returns:
            Hex string of the SHA-256 hash.
        """
        content = migration.path.read_text()
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    async def get_applied_migrations(self) -> dict[str, dict[str, Any]]:
        """Get all currently applied migrations from the tracking table.

        Returns:
            A dict mapping migration_id to its record:
            {migration_id: {applied_at, checksum, script_name}}
        """
        applied: dict[str, dict[str, Any]] = {}

        try:
            async with get_connection() as conn:
                # Check if tracking table exists
                table_exists = await conn.fetchval(
                    """
                    SELECT EXISTS (
                        SELECT FROM information_schema.tables
                        WHERE table_name = 'schema_migrations'
                    )
                    """
                )

                if not table_exists:
                    return {}

                # Fetch applied migrations
                rows = await conn.fetch(
                    """
                    SELECT migration_id, applied_at, checksum, script_name
                    FROM schema_migrations
                    ORDER BY migration_id
                    """
                )

                for row in rows:
                    applied[row["migration_id"]] = {
                        "applied_at": row["applied_at"],
                        "checksum": row["checksum"],
                        "script_name": row["script_name"],
                    }

        except Exception as e:
            logger.error("Error fetching applied migrations: %s", e)
            raise

        return applied

    def get_pending_migrations(self) -> list[Migration]:
        """Get migrations that have not yet been applied.

        Returns:
            A list of Migration objects that are pending application.
        """
        # Note: This is a sync wrapper - in a full implementation we'd use async
        # For now, we return all migrations and let apply_all handle the check
        import asyncio

        try:
            loop = asyncio.get_event_loop()
        except RuntimeError:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

        applied = loop.run_until_complete(self.get_applied_migrations())
        all_migrations = self.get_migrations()

        pending = []
        for migration in all_migrations:
            if migration.id not in applied:
                pending.append(migration)

        return pending

    async def _ensure_tracking_table(self) -> None:
        """Ensure the schema_migrations tracking table exists."""
        async with get_connection() as conn:
            await conn.execute("""
                CREATE TABLE IF NOT EXISTS schema_migrations (
                    migration_id VARCHAR(255) PRIMARY KEY,
                    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    checksum VARCHAR(64),
                    script_name TEXT NOT NULL
                )
            """)

    async def apply_migration(self, migration: Migration) -> dict[str, Any]:
        """Apply a single migration file.

        Args:
            migration: The migration to apply.

        Returns:
            A dict with keys: success, migration_id, error (if failed).
        """
        try:
            sql_content = migration.path.read_text()
            checksum = self._calculate_checksum(migration)

            async with get_connection() as conn:
                # Execute the migration SQL
                await conn.execute(sql_content)

                # Record the migration
                await conn.execute(
                    """
                    INSERT INTO schema_migrations (migration_id, checksum, script_name)
                    VALUES ($1, $2, $3)
                    ON CONFLICT (migration_id) DO UPDATE SET
                        applied_at = NOW(),
                        checksum = EXCLUDED.checksum,
                        script_name = EXCLUDED.script_name
                    """,
                    migration.id,
                    checksum,
                    migration.path.name,
                )

            logger.info("Applied migration: %s", migration.id)
            return {
                "success": True,
                "migration_id": migration.id,
                "checksum": checksum,
            }

        except Exception as e:
            logger.error("Failed to apply migration %s: %s", migration.id, e)
            return {
                "success": False,
                "migration_id": migration.id,
                "error": str(e),
            }

    async def apply_all(self) -> dict[str, Any]:
        """Apply all pending migrations in order.

        Returns:
            A dict with keys:
            - success: True if all migrations applied successfully
            - applied: List of migration IDs applied
            - skipped: List of migration IDs already applied
            - failed: List of failed migration IDs with errors
            - error: Overall error message (if success is False)
        """
        # Ensure tracking table exists first
        await self._ensure_tracking_table()

        # Get current state
        applied = await self.get_applied_migrations()
        all_migrations = self.get_migrations()

        applied_list: list[str] = []
        skipped_list: list[str] = []
        failed_list: list[dict[str, Any]] = []

        for migration in all_migrations:
            migration_id = migration.id

            # Check if already applied
            if migration_id in applied:
                existing_checksum = applied[migration_id]["checksum"]
                current_checksum = self._calculate_checksum(migration)

                # Verify migration hasn't been modified
                if existing_checksum != current_checksum:
                    logger.warning(
                        "Migration %s has been modified since it was applied. "
                        "Existing checksum: %s, Current: %s",
                        migration_id,
                        existing_checksum,
                        current_checksum,
                    )

                skipped_list.append(migration_id)
                continue

            # Apply the migration
            result = await self.apply_migration(migration)

            if result["success"]:
                applied_list.append(migration_id)
            else:
                failed_list.append(
                    {
                        "migration_id": migration_id,
                        "error": result.get("error", "Unknown error"),
                    }
                )
                # Stop on first failure
                break

        return {
            "success": len(failed_list) == 0,
            "applied": applied_list,
            "skipped": skipped_list,
            "failed": failed_list,
            "error": failed_list[0]["error"] if failed_list else None,
        }

    async def rollback_migration(self, migration_id: str) -> dict[str, Any]:
        """Rollback a specific migration.

        Note: This requires the migration to have a corresponding rollback
        file (e.g., 001_create_migrations_table_down.sql) or embedded
        rollback instructions.

        Args:
            migration_id: The ID of the migration to rollback.

        Returns:
            A dict with keys: success, migration_id, error (if failed).
        """
        # Find the migration file
        migrations = self.get_migrations()
        migration = next((m for m in migrations if m.id == migration_id), None)

        if not migration:
            return {
                "success": False,
                "migration_id": migration_id,
                "error": f"Migration {migration_id} not found",
            }

        # Try to find a rollback file
        rollback_path = migration.path.parent / f"{migration.id}_{migration.name}_down.sql"

        if not rollback_path.exists():
            return {
                "success": False,
                "migration_id": migration_id,
                "error": f"Rollback file not found: {rollback_path}",
            }

        try:
            sql_content = rollback_path.read_text()

            async with get_connection() as conn:
                await conn.execute(sql_content)

                # Remove from tracking table
                await conn.execute(
                    "DELETE FROM schema_migrations WHERE migration_id = $1",
                    migration_id,
                )

            logger.info("Rolled back migration: %s", migration_id)
            return {"success": True, "migration_id": migration_id}

        except Exception as e:
            logger.error("Failed to rollback migration %s: %s", migration_id, e)
            return {
                "success": False,
                "migration_id": migration_id,
                "error": str(e),
            }


def run_migrations() -> dict[str, Any]:
    """Convenience function to run all pending migrations synchronously.

    This is the main entry point for CLI usage.

    Returns:
        The result dict from apply_all().
    """
    import asyncio

    manager = MigrationManager()
    return asyncio.run(manager.apply_all())
