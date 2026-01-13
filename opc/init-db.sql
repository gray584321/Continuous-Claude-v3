-- OPC v3 Database Schema
-- Auto-run on first postgres startup

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ============================================================================
-- COORDINATION TABLES (from 06-concurrency-coordination.md)
-- ============================================================================

-- Agents table - tracks all spawned agents
CREATE TABLE agents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    agent_id TEXT UNIQUE NOT NULL,
    parent_agent_id UUID REFERENCES agents(id),
    premise TEXT,
    pattern TEXT,
    role TEXT,  -- Functional role within pattern (e.g., mapper, reducer, cruncher, validator)
    depth_level INTEGER DEFAULT 1,
    pid INTEGER,
    swarm_id TEXT,  -- Optional grouping for kill_swarm; defaults to session_id if not set
    status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'orphaned', 'killed')),
    spawned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    error_message TEXT,
    result_summary TEXT,
    -- TUI observability columns for live agent monitoring
    current_todos JSONB DEFAULT '[]',
    last_tool TEXT,
    last_tool_at TIMESTAMPTZ,
    -- HUD observability columns (Phase 1 of TUI refactor)
    handoff_to UUID REFERENCES agents(id),  -- Link to continuation agent after context overflow
    context_usage FLOAT DEFAULT 0.0  -- Current context % (0.0 to 1.0)
);

CREATE INDEX idx_agents_session ON agents(session_id);
CREATE INDEX idx_agents_status ON agents(status);
CREATE INDEX idx_agents_pattern ON agents(pattern);
CREATE INDEX idx_agents_role ON agents(role) WHERE role IS NOT NULL;
CREATE INDEX idx_agents_parent ON agents(parent_agent_id);
CREATE INDEX idx_agents_swarm ON agents(swarm_id) WHERE swarm_id IS NOT NULL;
CREATE INDEX idx_agents_handoff ON agents(handoff_to) WHERE handoff_to IS NOT NULL;

-- Blackboard for inter-agent messaging (MESSAGE_PROTOCOL.md)
CREATE TABLE blackboard (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    swarm_id TEXT NOT NULL,
    sender_agent TEXT NOT NULL,
    message_type TEXT NOT NULL CHECK (message_type IN ('request', 'response', 'status', 'directive', 'checkpoint')),
    target_agent TEXT,  -- NULL = broadcast to all
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    read_by JSONB DEFAULT '[]'::jsonb,  -- Array of agent_ids that have read this
    archived_at TIMESTAMPTZ  -- For cleanup
);

CREATE INDEX idx_blackboard_swarm ON blackboard(swarm_id, created_at);
CREATE INDEX idx_blackboard_target ON blackboard(target_agent) WHERE target_agent IS NOT NULL;
CREATE INDEX idx_blackboard_priority ON blackboard(priority) WHERE priority = 'critical';

-- Sandbox computations (shared state between agents)
CREATE TABLE sandbox_computations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value JSONB NOT NULL,
    computed_by TEXT NOT NULL,  -- agent_id
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    UNIQUE(session_id, key)
);

CREATE INDEX idx_sandbox_session_key ON sandbox_computations(session_id, key);

-- ============================================================================
-- SPAWN QUEUE (from master spec - replaces "spawn blackboard")
-- ============================================================================

CREATE TABLE spawn_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requester_agent TEXT NOT NULL,
    target_agent_type TEXT NOT NULL,  -- e.g. 'kraken', 'scout', 'sleuth'
    depth_level INTEGER NOT NULL,
    priority TEXT DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'critical')),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'spawned')),
    payload JSONB NOT NULL,  -- Task description, context
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    spawned_agent_id UUID REFERENCES agents(id),
    depends_on UUID[] DEFAULT '{}',  -- DAG: IDs of tasks that must complete first
    blocked_by_count INTEGER DEFAULT 0  -- Kahn's algorithm: count of unspawned dependencies
);

CREATE INDEX idx_spawn_queue_status ON spawn_queue(status, priority, created_at);
CREATE INDEX idx_spawn_queue_requester ON spawn_queue(requester_agent);
CREATE INDEX idx_spawn_queue_deps ON spawn_queue USING GIN(depends_on);
-- Partial index for O(1) lookup of ready tasks
CREATE INDEX idx_spawn_queue_ready ON spawn_queue(status, blocked_by_count) WHERE status = 'pending' AND blocked_by_count = 0;

-- ============================================================================
-- TEMPORAL MEMORY (from 02-temporal-memory-assessment.md)
-- ============================================================================

CREATE TABLE temporal_facts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id TEXT NOT NULL,
    fact_type TEXT NOT NULL,  -- 'observation', 'decision', 'learning', 'preference'
    content TEXT NOT NULL,
    embedding vector(1536),  -- OpenAI ada-002 dimension
    confidence FLOAT DEFAULT 1.0,
    source_turn INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    metadata JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX idx_temporal_session ON temporal_facts(session_id, created_at DESC);
CREATE INDEX idx_temporal_type ON temporal_facts(fact_type);
CREATE INDEX idx_temporal_embedding ON temporal_facts USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

-- ============================================================================
-- AGENT LOGS (centralized logging from Round 3 decisions)
-- ============================================================================

CREATE TABLE agent_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    level TEXT NOT NULL CHECK (level IN ('debug', 'info', 'warn', 'error')),
    message TEXT NOT NULL,
    metadata JSONB DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_logs_agent ON agent_logs(agent_id, created_at DESC);
CREATE INDEX idx_agent_logs_session ON agent_logs(session_id, created_at DESC);
CREATE INDEX idx_agent_logs_level ON agent_logs(level) WHERE level IN ('warn', 'error');

-- ============================================================================
-- CHECKPOINTS (crash recovery from Round 3)
-- ============================================================================

CREATE TABLE checkpoints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    agent_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    context_usage FLOAT,
    files_modified JSONB DEFAULT '[]'::jsonb,
    unknowns JSONB DEFAULT '[]'::jsonb,
    handoff_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_checkpoints_agent ON checkpoints(agent_id, created_at DESC);
CREATE INDEX idx_checkpoints_session ON checkpoints(session_id, created_at DESC);

-- ============================================================================
-- USER PREFERENCES (from 07-z3-erotetic.md - personalization)
-- ============================================================================

CREATE TABLE user_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    proposition TEXT NOT NULL,
    choice TEXT NOT NULL,
    context TEXT,
    count INTEGER DEFAULT 1,
    last_used TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, proposition, choice)
);

CREATE INDEX idx_preferences_user ON user_preferences(user_id);
CREATE INDEX idx_preferences_proposition ON user_preferences(user_id, proposition);

-- ============================================================================
-- FINDINGS (research/tracking findings)
-- ============================================================================

CREATE TABLE IF NOT EXISTS findings (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    finding TEXT NOT NULL,
    relevant_to TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_findings_session ON findings(session_id);
CREATE INDEX idx_findings_topic ON findings(topic);
CREATE INDEX idx_findings_created ON findings(created_at DESC);
CREATE INDEX idx_findings_relevant ON findings USING GIN(relevant_to);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

-- Cleanup old blackboard messages (run periodically)
CREATE OR REPLACE FUNCTION archive_old_blackboard_messages(older_than INTERVAL DEFAULT '7 days')
RETURNS INTEGER AS $$
DECLARE
    archived_count INTEGER;
BEGIN
    UPDATE blackboard
    SET archived_at = NOW()
    WHERE archived_at IS NULL
      AND created_at < NOW() - older_than;
    GET DIAGNOSTICS archived_count = ROW_COUNT;
    RETURN archived_count;
END;
$$ LANGUAGE plpgsql;

-- Get active agent count for session (resource limiting)
CREATE OR REPLACE FUNCTION get_active_agent_count(p_session_id TEXT)
RETURNS INTEGER AS $$
BEGIN
    RETURN (
        SELECT COUNT(*)
        FROM agents
        WHERE session_id = p_session_id
          AND status = 'running'
    );
END;
$$ LANGUAGE plpgsql;
