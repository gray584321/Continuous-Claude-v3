-- Migration: Memory System Enhancements
-- Generated: 2026-01-14
-- Purpose: Add tables for smarter memory with TLDR integration, checkpoints, and feature workspaces
--
-- Tables Added:
--   - codebase_scans: TLDR analysis results with embeddings
--   - checkpoints: Session recovery snapshots
--   - feature_workspaces: Parallel feature tracking
--
-- Columns Added:
--   - sessions: phase, active_files, blocked_by, next_action
--   - archival_memory: importance_score, embedding_model
--
-- Run with: docker exec -i continuous-claude-postgres psql -U claude -d continuous_claude < 003_memory_enhancements.sql

-- ============================================================================
-- ENHANCE SESSIONS TABLE
-- ============================================================================

-- Add columns for richer state tracking (team awareness)
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS current_phase TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS active_files JSONB DEFAULT '[]';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS blocked_by TEXT[];
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS next_action TEXT;

-- Add indexes for the new columns
CREATE INDEX IF NOT EXISTS idx_sessions_project_phase
ON sessions(project, current_phase) WHERE current_phase IS NOT NULL;

-- Note: Partial index with NOW() not supported (NOW() is not IMMUTABLE)
-- Using full index instead for active sessions query
CREATE INDEX IF NOT EXISTS idx_sessions_active
ON sessions(last_heartbeat DESC);

-- ============================================================================
-- ENHANCE ARCHIVAL_MEMORY TABLE
-- ============================================================================

-- Add importance scoring for smart pruning
ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS importance_score FLOAT DEFAULT 0.5;

-- Track which embedding model generated each vector (for migration/re-generation)
ALTER TABLE archival_memory ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'Qwen3-Embedding-0.6B';

-- Add index on importance for pruning queries
-- Note: Using full index instead of partial (WHERE IS NOT NULL) for compatibility
CREATE INDEX IF NOT EXISTS idx_archival_importance
ON archival_memory(importance_score DESC, created_at DESC);

-- ============================================================================
-- CODEBASE_SCANS TABLE (NEW)
-- ============================================================================

-- Store TLDR analysis results with embeddings for semantic search
CREATE TABLE IF NOT EXISTS codebase_scans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    project TEXT NOT NULL,
    scan_type TEXT NOT NULL CHECK (scan_type IN (
        'structure',    -- Function/class counts
        'arch',         -- Architecture layers
        'diagnostics',  -- Type/lint errors
        'dead',         -- Dead code
        'imports',      -- Dependencies
        'impact',       -- Call relationships
        'full'          -- Full scan
    )),
    content TEXT NOT NULL,           -- TLDR output summary
    embedding vector(1024),          -- Semantic embedding for search
    embedding_model TEXT DEFAULT 'Qwen/Qwen3-Embedding-0.6B',
    metadata JSONB DEFAULT '{}',     -- Additional scan data (file counts, etc.)
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for codebase_scans
CREATE INDEX IF NOT EXISTS idx_codebase_scans_session
ON codebase_scans(session_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_codebase_scans_project_type
ON codebase_scans(project, scan_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_codebase_scans_embedding
ON codebase_scans USING ivfflat (embedding vector_cosine_ops)
WITH (lists = 100);

-- ============================================================================
-- CHECKPOINTS TABLE (NEW)
-- ============================================================================

-- Session recovery snapshots (inspired by gastown checkpoint pattern)
CREATE TABLE IF NOT EXISTS checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    session_name TEXT NOT NULL,
    project TEXT NOT NULL,

    -- Recovery state
    current_step TEXT,
    current_task TEXT,

    -- Git state for recovery
    modified_files JSONB DEFAULT '[]',
    uncommitted_changes BOOLEAN DEFAULT FALSE,
    last_commit TEXT,
    branch TEXT,

    -- Context
    goal TEXT,
    progress TEXT,
    notes TEXT,

    -- Learning summary
    learnings_extracted INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days'
);

-- Indexes for checkpoints
CREATE INDEX IF NOT EXISTS idx_checkpoints_session
ON checkpoints(session_id, created_at DESC);

-- Note: Using full index for expiry (NOW() not IMMUTABLE in partial index)
CREATE INDEX IF NOT EXISTS idx_checkpoints_expiry
ON checkpoints(expires_at);

CREATE INDEX IF NOT EXISTS idx_checkpoints_project
ON checkpoints(project, created_at DESC);

-- ============================================================================
-- FEATURE_WORKSPACES TABLE (NEW)
-- ============================================================================

-- Track parallel feature work across agents/sessions
CREATE TABLE IF NOT EXISTS feature_workspaces (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project TEXT NOT NULL,
    feature_name TEXT NOT NULL,
    feature_id TEXT NOT NULL,  -- URL-safe identifier for UI

    -- Assignment
    session_id TEXT,
    agent_id TEXT,
    parent_workspace_id UUID REFERENCES feature_workspaces(id) ON DELETE SET NULL,

    -- State
    status TEXT DEFAULT 'active' CHECK (status IN (
        'active', 'blocked', 'review', 'complete', 'archived'
    )),
    priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),

    -- Details
    description TEXT,
    goals JSONB DEFAULT '[]',
    blockers TEXT[],
    related_files JSONB DEFAULT '[]',

    -- Metrics
    tasks_total INTEGER DEFAULT 0,
    tasks_complete INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for feature_workspaces
CREATE INDEX IF NOT EXISTS idx_feature_workspaces_project
ON feature_workspaces(project, status, priority DESC);

CREATE INDEX IF NOT EXISTS idx_feature_workspaces_session
ON feature_workspaces(session_id);

CREATE INDEX IF NOT EXISTS idx_feature_workspaces_name
ON feature_workspaces(project, feature_id);

-- ============================================================================
-- BLACKBOARD ENHANCEMENTS (optional - for agent coordination)
-- ============================================================================
-- Note: blackboard table may not exist in all deployments
-- These are optional enhancements for multi-agent coordination

-- Only add if blackboard table exists (suppress errors if not)
DO $$
BEGIN
    IF EXISTS (SELECT FROM information_schema.tables WHERE table_name = 'blackboard') THEN
        ALTER TABLE blackboard ADD COLUMN IF NOT EXISTS priority INTEGER DEFAULT 5;
        ALTER TABLE blackboard ADD COLUMN IF NOT EXISTS ttl_seconds INTEGER DEFAULT 3600;
        CREATE INDEX IF NOT EXISTS idx_blackboard_swarm_priority
        ON blackboard(swarm_id, priority DESC, created_at DESC)
        WHERE completed_at IS NULL;
    END IF;
END $$;

-- ============================================================================
-- MIGRATION TRACKING
-- ============================================================================

-- Record this migration
CREATE TABLE IF NOT EXISTS migration_log (
    id SERIAL PRIMARY KEY,
    migration_name TEXT NOT NULL UNIQUE,
    applied_at TIMESTAMPTZ DEFAULT NOW(),
    success BOOLEAN DEFAULT TRUE,
    error_message TEXT
);

INSERT INTO migration_log (migration_name)
VALUES ('003_memory_enhancements')
ON CONFLICT (migration_name) DO NOTHING;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

-- Check new tables exist
-- SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
--   AND table_name IN ('codebase_scans', 'checkpoints', 'feature_workspaces');

-- Check sessions has new columns
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'sessions' AND column_name IN (
--     'current_phase', 'active_files', 'blocked_by', 'next_action'
--   );

-- Check archival_memory has new columns
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'archival_memory' AND column_name IN (
--     'importance_score', 'embedding_model'
--   );

-- Show migration status
-- SELECT * FROM migration_log ORDER BY applied_at DESC;
