-- Migration: 001_create_migrations_table
-- Description: Create schema_migrations tracking table
-- Applied: Never (idempotent via IF NOT EXISTS)
-- Up: Creates tracking table
-- Down: Drops tracking table

-- Create the migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
    migration_id VARCHAR(255) PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    checksum VARCHAR(64),
    script_name TEXT NOT NULL
);

-- Create index on applied_at for performance when querying migration history
CREATE INDEX IF NOT EXISTS idx_schema_migrations_applied_at ON schema_migrations(applied_at);

-- Idempotent: CREATE TABLE IF NOT EXISTS handles re-runs
