"""Database migration framework for Continuous Claude.

This module provides a migration system that:
- Tracks applied migrations in a schema_migrations table
- Supports idempotent migrations (safe to re-run)
- Provides rollback capability
- Integrates with wizard.py and update.py for seamless deployment

Usage:
    from scripts.migrations.migration_manager import MigrationManager

    manager = MigrationManager()
    result = manager.apply_all()

    # Check which migrations were applied
    applied = manager.get_applied_migrations()
    pending = manager.get_pending_migrations()
"""

from scripts.migrations.migration_manager import Migration, MigrationManager

__all__ = ["Migration", "MigrationManager"]
