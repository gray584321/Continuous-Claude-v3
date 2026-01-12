-- Migration: 002_add_health_check_history
-- Description: Add health_check_history table for system monitoring
-- Applied: After 001_create_migrations_table
-- Up: Creates health check history table
-- Down: Drops health check history table

-- Create health check history table for system monitoring
CREATE TABLE IF NOT EXISTS health_check_history (
    id SERIAL PRIMARY KEY,
    check_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status VARCHAR(50) NOT NULL,
    details JSONB,
    response_time_ms REAL,
    error_message TEXT
);

-- Create index on check_time for time-based queries
CREATE INDEX IF NOT EXISTS idx_health_check_history_time ON health_check_history(check_time);

-- Create index on status for filtering by health status
CREATE INDEX IF NOT EXISTS idx_health_check_history_status ON health_check_history(status);

-- Idempotent: CREATE TABLE IF NOT EXISTS handles re-runs
