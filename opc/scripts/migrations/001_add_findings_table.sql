-- ============================================================================
-- Migration 001: Add Findings Table
-- Created: 2026-01-12
-- Purpose: Track research findings and observations for coordination layer
-- ============================================================================

-- Findings table for research/tracking findings
CREATE TABLE IF NOT EXISTS findings (
    id SERIAL PRIMARY KEY,
    session_id TEXT NOT NULL,
    topic TEXT NOT NULL,
    finding TEXT NOT NULL,
    relevant_to TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes for findings table
CREATE INDEX IF NOT EXISTS idx_findings_session ON findings(session_id);
CREATE INDEX IF NOT EXISTS idx_findings_topic ON findings(topic);
CREATE INDEX IF NOT EXISTS idx_findings_created ON findings(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_findings_relevant ON findings USING GIN(relevant_to);
