/**
 * Unified Swarm Pattern Handlers
 *
 * Consolidates swarm coordination logic from:
 * - subagent-start-swarm.ts -> onSubagentStart
 * - subagent-stop-swarm.ts -> onSubagentStop
 * - pre-tool-use-broadcast.ts -> onPreToolUse
 * - post-task-complete.ts -> onPostToolUse
 * - stop-swarm-coordinator.ts -> onStop
 *
 * Environment Variables:
 * - SWARM_ID: Swarm identifier (required for swarm operations)
 * - AGENT_ID: Current agent identifier (for PreToolUse)
 * - CLAUDE_PROJECT_DIR: Project directory for DB path
 */

import { existsSync } from 'fs';

// Import shared utilities
import { getDbPath, runPythonQuery, isValidId } from '../shared/db-utils.js';
import type {
  SubagentStartInput,
  SubagentStopInput,
  PreToolUseInput,
  PostToolUseInput,
  StopInput,
  HookOutput
} from '../shared/types.js';

// Re-export types for convenience
export type {
  SubagentStartInput,
  SubagentStopInput,
  PreToolUseInput,
  PostToolUseInput,
  StopInput,
  HookOutput
};

// =============================================================================
// State Transfer Types
// =============================================================================

/**
 * Represents the state of an agent that can be transferred during handoff.
 */
export interface AgentState {
  /** Key-value context data */
  context: Record<string, unknown>;
  /** Memory/learned information */
  memory: Record<string, unknown>;
  /** Progress percentage (0-100) */
  progress: number;
  /** List of pending task descriptions */
  pendingTasks: string[];
}

/**
 * State transfer message between agents in a swarm.
 */
export interface SwarmStateTransfer {
  /** Agent sending the state */
  sourceAgent: string;
  /** Agent receiving the state */
  targetAgent: string;
  /** The actual state being transferred */
  state: AgentState;
  /** ISO timestamp of transfer */
  timestamp: string;
  /** SHA-256 checksum for integrity verification */
  checksum: string;
}

/**
 * Swarm configuration with state transfer options.
 */
export interface SwarmConfig {
  /** Unique swarm identifier */
  swarmId: string;
  /** Enable automatic state transfer on agent handoff */
  enableStateTransfer: boolean;
  /** Maximum state size in bytes (default: 1MB) */
  maxStateSize?: number;
}

// In-memory state storage (per-agent)
const agentStates: Map<string, AgentState> = new Map();

// =============================================================================
// State Management Functions
// =============================================================================

/**
 * Get context data for an agent.
 */
function getContext(agentId: string): Record<string, unknown> {
  return agentStates.get(agentId)?.context ?? {};
}

/**
 * Get memory data for an agent.
 */
function getMemory(agentId: string): Record<string, unknown> {
  return agentStates.get(agentId)?.memory ?? {};
}

/**
 * Get progress for an agent.
 */
function getProgress(agentId: string): number {
  return agentStates.get(agentId)?.progress ?? 0;
}

/**
 * Get pending tasks for an agent.
 */
function getPendingTasks(agentId: string): string[] {
  return agentStates.get(agentId)?.pendingTasks ?? [];
}

/**
 * Restore context for an agent.
 */
function restoreContext(agentId: string, context: Record<string, unknown>): void {
  const state = agentStates.get(agentId) ?? createEmptyState();
  state.context = context;
  agentStates.set(agentId, state);
}

/**
 * Restore memory for an agent.
 */
function restoreMemory(agentId: string, memory: Record<string, unknown>): void {
  const state = agentStates.get(agentId) ?? createEmptyState();
  state.memory = memory;
  agentStates.set(agentId, state);
}

/**
 * Restore progress for an agent.
 */
function restoreProgress(agentId: string, progress: number): void {
  const state = agentStates.get(agentId) ?? createEmptyState();
  state.progress = progress;
  agentStates.set(agentId, state);
}

/**
 * Restore pending tasks for an agent.
 */
function restorePendingTasks(agentId: string, tasks: string[]): void {
  const state = agentStates.get(agentId) ?? createEmptyState();
  state.pendingTasks = tasks;
  agentStates.set(agentId, state);
}

/**
 * Create an empty agent state.
 */
function createEmptyState(): AgentState {
  return {
    context: {},
    memory: {},
    progress: 0,
    pendingTasks: [],
  };
}

/**
 * Initialize or update agent state.
 */
export function setAgentState(agentId: string, state: Partial<AgentState>): void {
  const existing = agentStates.get(agentId) ?? createEmptyState();
  agentStates.set(agentId, {
    context: state.context ?? existing.context,
    memory: state.memory ?? existing.memory,
    progress: state.progress ?? existing.progress,
    pendingTasks: state.pendingTasks ?? existing.pendingTasks,
  });
}

/**
 * Get full agent state.
 */
export function getAgentState(agentId: string): AgentState | undefined {
  return agentStates.get(agentId);
}

/**
 * Clear agent state from memory.
 */
export function clearAgentState(agentId: string): void {
  agentStates.delete(agentId);
}

// =============================================================================
// State Serialization
// =============================================================================

/**
 * Compute SHA-256 checksum for state integrity verification.
 */
function computeChecksum(data: string): string {
  // Simple hash for integrity check (in production, use crypto.createHash)
  let hash = 0;
  for (let i = 0; i < data.length; i++) {
    const char = data.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

/**
 * Serialize agent state to a transferable string format.
 * @param agentId - The agent whose state to serialize
 * @returns JSON string of the agent's state
 */
export async function serializeState(agentId: string): Promise<string> {
  const state: AgentState = {
    context: getContext(agentId),
    memory: getMemory(agentId),
    progress: getProgress(agentId),
    pendingTasks: getPendingTasks(agentId),
  };
  return JSON.stringify(state);
}

/**
 * Deserialize and restore agent state from a string.
 * @param agentId - The agent to restore state for
 * @param serialized - JSON string of the state
 */
export async function deserializeState(agentId: string, serialized: string): Promise<void> {
  const state: AgentState = JSON.parse(serialized);
  restoreContext(agentId, state.context);
  restoreMemory(agentId, state.memory);
  restoreProgress(agentId, state.progress);
  restorePendingTasks(agentId, state.pendingTasks);
}

/**
 * Validate state checksum for integrity.
 */
export function validateChecksum(serialized: string, expectedChecksum: string): boolean {
  const actualChecksum = computeChecksum(serialized);
  return actualChecksum === expectedChecksum;
}

// =============================================================================
// State Transfer Handlers
// =============================================================================

/**
 * Publish state transfer to the database for pickup by target agent.
 */
async function publishStateTransfer(
  sourceAgent: string,
  targetAgent: string,
  serializedState: string
): Promise<void> {
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    console.error('[state-transfer] Database not found:', dbPath);
    return;
  }

  const swarmId = process.env.SWARM_ID;
  if (!swarmId || !isValidId(swarmId)) {
    console.error('[state-transfer] Invalid or missing SWARM_ID');
    return;
  }

  const checksum = computeChecksum(serializedState);
  const transfer: SwarmStateTransfer = {
    sourceAgent,
    targetAgent,
    state: JSON.parse(serializedState),
    timestamp: new Date().toISOString(),
    checksum,
  };

  const query = `
import sqlite3
import json
import sys
from datetime import datetime
from uuid import uuid4

db_path = sys.argv[1]
swarm_id = sys.argv[2]
source_agent = sys.argv[3]
target_agent = sys.argv[4]
state_json = sys.argv[5]

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

broadcast_id = uuid4().hex[:12]
payload = json.dumps({
    "type": "state_transfer",
    "targetAgent": target_agent,
    "state": json.loads(state_json),
    "checksum": sys.argv[6]
})
conn.execute('''
    INSERT INTO broadcasts (id, swarm_id, sender_agent, broadcast_type, payload, created_at)
    VALUES (?, ?, ?, 'state_transfer', ?, ?)
''', (broadcast_id, swarm_id, source_agent, payload, datetime.now().isoformat()))
conn.commit()
conn.close()
print(json.dumps({"success": True, "broadcast_id": broadcast_id}))
`;

  const result = runPythonQuery(query, [
    dbPath,
    swarmId,
    sourceAgent,
    targetAgent,
    serializedState,
    checksum,
  ]);

  if (!result.success) {
    console.error('[state-transfer] Failed to publish:', result.stderr);
  } else {
    console.error(`[state-transfer] Published state from ${sourceAgent} to ${targetAgent}`);
  }
}

/**
 * Retrieve pending state transfer for an agent.
 */
async function retrieveStateTransfer(agentId: string): Promise<SwarmStateTransfer | null> {
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return null;
  }

  const swarmId = process.env.SWARM_ID;
  if (!swarmId || !isValidId(swarmId)) {
    return null;
  }

  const query = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
swarm_id = sys.argv[2]
agent_id = sys.argv[3]

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")
conn.row_factory = sqlite3.Row

cursor = conn.execute('''
    SELECT sender_agent, payload, created_at
    FROM broadcasts
    WHERE swarm_id = ? AND broadcast_type = 'state_transfer'
    ORDER BY created_at DESC
    LIMIT 10
''', (swarm_id,))

for row in cursor.fetchall():
    payload = json.loads(row['payload'])
    if payload.get('targetAgent') == agent_id:
        result = {
            'sourceAgent': row['sender_agent'],
            'targetAgent': agent_id,
            'state': payload.get('state', {}),
            'timestamp': row['created_at'],
            'checksum': payload.get('checksum', '')
        }
        print(json.dumps(result))
        conn.close()
        exit(0)

print(json.dumps(None))
conn.close()
`;

  const result = runPythonQuery(query, [dbPath, swarmId, agentId]);

  if (!result.success) {
    console.error('[state-transfer] Failed to retrieve:', result.stderr);
    return null;
  }

  try {
    const transfer = JSON.parse(result.stdout);
    return transfer;
  } catch {
    return null;
  }
}

/**
 * State transfer event handlers for swarm coordination.
 */
export const stateTransferHandlers = {
  /**
   * Handle request to transfer state from one agent to another.
   */
  onStateRequest: async (fromAgent: string, toAgent: string): Promise<void> => {
    const state = await serializeState(fromAgent);
    await publishStateTransfer(fromAgent, toAgent, state);
  },

  /**
   * Handle receiving state from another agent.
   */
  onStateReceived: async (agentId: string, state: string): Promise<void> => {
    await deserializeState(agentId, state);
  },

  /**
   * Initialize state for a new agent, checking for pending transfers.
   */
  onAgentInit: async (agentId: string): Promise<boolean> => {
    const transfer = await retrieveStateTransfer(agentId);
    if (transfer) {
      const serialized = JSON.stringify(transfer.state);
      if (validateChecksum(serialized, transfer.checksum)) {
        await deserializeState(agentId, serialized);
        console.error(`[state-transfer] Restored state for ${agentId} from ${transfer.sourceAgent}`);
        return true;
      } else {
        console.error(`[state-transfer] Checksum mismatch for ${agentId}, ignoring transfer`);
      }
    }
    return false;
  },
};

// =============================================================================
// onSubagentStart Handler
// =============================================================================

/**
 * Handles SubagentStart hook for swarm pattern.
 * Logs agent joining swarm to stderr.
 * Attempts to restore state from any pending transfers.
 * Always returns 'continue' - never blocks agent start.
 */
export async function onSubagentStart(input: SubagentStartInput): Promise<HookOutput> {
  const swarmId = process.env.SWARM_ID;

  // If no SWARM_ID, continue silently (not in a swarm)
  if (!swarmId) {
    return { result: 'continue' };
  }

  // Validate SWARM_ID format
  if (!isValidId(swarmId)) {
    return { result: 'continue' };
  }

  const agentId = input.agent_id ?? 'unknown';
  const agentType = input.agent_type ?? 'unknown';

  // Log for debugging - this goes to stderr, not stdout
  console.error(`[subagent-start] Agent ${agentId} (type: ${agentType}) joining swarm ${swarmId}`);

  // Check for state transfer if enabled
  const enableStateTransfer = process.env.SWARM_STATE_TRANSFER === 'true';
  if (enableStateTransfer && agentId !== 'unknown') {
    try {
      const restored = await stateTransferHandlers.onAgentInit(agentId);
      if (restored) {
        const state = getAgentState(agentId);
        return {
          result: 'continue',
          message: `State restored from previous agent. Progress: ${state?.progress ?? 0}%, Pending tasks: ${state?.pendingTasks?.length ?? 0}`
        };
      }
    } catch (err) {
      console.error('[subagent-start] State restore error:', err);
    }
  }

  // Always return continue - SubagentStart should never block
  return { result: 'continue' };
}

// =============================================================================
// onSubagentStop Handler
// =============================================================================

/**
 * Handles SubagentStop hook for swarm pattern.
 * Broadcasts 'done' message with auto flag.
 * Serializes and publishes state for handoff if enabled.
 * Injects synthesis message when all agents complete.
 */
export async function onSubagentStop(input: SubagentStopInput): Promise<HookOutput> {
  const swarmId = process.env.SWARM_ID;

  // If no SWARM_ID, continue silently
  if (!swarmId) {
    return { result: 'continue' };
  }

  // Validate SWARM_ID format
  if (!isValidId(swarmId)) {
    return { result: 'continue' };
  }

  const agentId = input.agent_id ?? 'unknown';

  // Validate agent_id format
  if (!isValidId(agentId)) {
    return { result: 'continue' };
  }

  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  // Serialize state on stop if state transfer is enabled
  const enableStateTransfer = process.env.SWARM_STATE_TRANSFER === 'true';
  const targetAgent = process.env.SWARM_HANDOFF_TARGET;
  if (enableStateTransfer && agentId !== 'unknown' && targetAgent) {
    try {
      await stateTransferHandlers.onStateRequest(agentId, targetAgent);
      console.error(`[subagent-stop] State serialized for handoff to ${targetAgent}`);
    } catch (err) {
      console.error('[subagent-stop] State serialization error:', err);
    }
  }

  try {
    // Auto-broadcast "done" message and check if all agents complete
    const query = `
import sqlite3
import json
import sys
from datetime import datetime
from uuid import uuid4

db_path = sys.argv[1]
swarm_id = sys.argv[2]
agent_id = sys.argv[3]

conn = sqlite3.connect(db_path)
# Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

# Insert done broadcast with auto flag
broadcast_id = uuid4().hex[:12]
conn.execute('''
    INSERT INTO broadcasts (id, swarm_id, sender_agent, broadcast_type, payload, created_at)
    VALUES (?, ?, ?, 'done', '{"auto": true}', ?)
''', (broadcast_id, swarm_id, agent_id, datetime.now().isoformat()))
conn.commit()

# Count agents that have broadcast "done" - distinct sender_agent
cursor = conn.execute('''
    SELECT COUNT(DISTINCT sender_agent) as done_count
    FROM broadcasts
    WHERE swarm_id = ? AND broadcast_type = 'done'
''', (swarm_id,))
done_count = cursor.fetchone()[0]

# Count total agents - any agent that has ever broadcast anything in this swarm
cursor = conn.execute('''
    SELECT COUNT(DISTINCT sender_agent) as total_count
    FROM broadcasts
    WHERE swarm_id = ?
''', (swarm_id,))
total_count = cursor.fetchone()[0]

conn.close()
print(json.dumps({'done': done_count, 'total': total_count}))
`;

    const result = runPythonQuery(query, [dbPath, swarmId, agentId]);

    if (!result.success) {
      console.error('SubagentStop Python error:', result.stderr);
      return { result: 'continue' };
    }

    // Parse Python output
    let counts: { done: number; total: number };
    try {
      counts = JSON.parse(result.stdout);
    } catch (parseErr) {
      return { result: 'continue' };
    }

    // Log for debugging
    console.error(`[subagent-stop] Agent ${agentId} done. Progress: ${counts.done}/${counts.total}`);

    // Check if all agents have completed
    if (counts.done >= counts.total && counts.total > 0) {
      return {
        result: 'continue',
        message: 'All agents complete. Consider synthesizing findings into final report.'
      };
    }

    return { result: 'continue' };
  } catch (err) {
    console.error('SubagentStop hook error:', err);
    return { result: 'continue' };
  }
}

// =============================================================================
// onPreToolUse Handler
// =============================================================================

/**
 * Handles PreToolUse hook for swarm pattern.
 * Injects broadcasts from other agents into context.
 * Excludes current agent's own broadcasts.
 */
export async function onPreToolUse(input: PreToolUseInput): Promise<HookOutput> {
  const swarmId = process.env.SWARM_ID;

  // If no SWARM_ID, continue silently
  if (!swarmId) {
    return { result: 'continue' };
  }

  // Validate SWARM_ID format
  if (!isValidId(swarmId)) {
    return { result: 'continue' };
  }

  const agentId = process.env.AGENT_ID || 'unknown';

  // Validate AGENT_ID format if provided
  if (agentId !== 'unknown' && !isValidId(agentId)) {
    return { result: 'continue' };
  }

  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  try {
    // Query broadcasts from other agents
    const query = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
swarm_id = sys.argv[2]
agent_id = sys.argv[3]

conn = sqlite3.connect(db_path)
# Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")
conn.row_factory = sqlite3.Row
cursor = conn.execute('''
    SELECT sender_agent, broadcast_type, payload, created_at
    FROM broadcasts
    WHERE swarm_id = ? AND sender_agent != ?
    ORDER BY created_at DESC
    LIMIT 10
''', (swarm_id, agent_id))

broadcasts = []
for row in cursor.fetchall():
    broadcasts.append({
        'sender': row['sender_agent'],
        'type': row['broadcast_type'],
        'payload': json.loads(row['payload']),
        'time': row['created_at']
    })

print(json.dumps(broadcasts))
`;

    const result = runPythonQuery(query, [dbPath, swarmId, agentId]);

    if (!result.success) {
      return { result: 'continue' };
    }

    const broadcasts = JSON.parse(result.stdout || '[]');

    if (broadcasts.length > 0) {
      let contextMessage = '\n--- SWARM BROADCASTS ---\n';
      for (const b of broadcasts) {
        contextMessage += `[${b.type.toUpperCase()}] from ${b.sender}:\n`;
        contextMessage += `  ${JSON.stringify(b.payload)}\n`;
      }
      contextMessage += '------------------------\n';

      return {
        result: 'continue',
        message: contextMessage
      };
    }

    return { result: 'continue' };
  } catch (err) {
    console.error('Broadcast query error:', err);
    return { result: 'continue' };
  }
}

// =============================================================================
// onPostToolUse Handler
// =============================================================================

/**
 * Handles PostToolUse hook for swarm pattern.
 * Records 'started' broadcast when Task tool spawns a new agent.
 * Ignores non-Task tools.
 */
export async function onPostToolUse(input: PostToolUseInput): Promise<HookOutput> {
  // Only track Task tool completions
  if (input.tool_name !== 'Task') {
    return { result: 'continue' };
  }

  const swarmId = process.env.SWARM_ID;

  if (!swarmId) {
    return { result: 'continue' };
  }

  // Validate SWARM_ID format
  if (!isValidId(swarmId)) {
    return { result: 'continue' };
  }

  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  try {
    // Extract agent_id from tool_response
    const response = input.tool_response as Record<string, unknown> | null;
    let agentId = 'unknown';
    if (response && typeof response === 'object' && 'agent_id' in response) {
      const rawAgentId = response.agent_id;
      // Security: Validate extracted agentId before use (defense-in-depth)
      if (typeof rawAgentId === 'string' && rawAgentId.length > 0 && isValidId(rawAgentId)) {
        agentId = rawAgentId;
      }
    }

    // Record a "started" broadcast to track which agents are in the swarm
    const insert = `
import sqlite3
import json
import sys
from datetime import datetime
from uuid import uuid4

db_path = sys.argv[1]
swarm_id = sys.argv[2]
agent_id = sys.argv[3]

conn = sqlite3.connect(db_path)
# Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

# Insert "started" broadcast to track this agent in the swarm
broadcast_id = uuid4().hex[:12]
payload = json.dumps({"type": "task_spawned"})
conn.execute('''
    INSERT INTO broadcasts (id, swarm_id, sender_agent, broadcast_type, payload, created_at)
    VALUES (?, ?, ?, 'started', ?, ?)
''', (broadcast_id, swarm_id, agent_id, payload, datetime.now().isoformat()))
conn.commit()
conn.close()
`;

    const result = runPythonQuery(insert, [dbPath, swarmId, agentId]);

    if (!result.success) {
      console.error('Task completion tracking error:', result.stderr);
    }

    return { result: 'continue' };
  } catch (err) {
    console.error('Task completion tracking error:', err);
    return { result: 'continue' };
  }
}

// =============================================================================
// onStop Handler
// =============================================================================

/**
 * Handles Stop hook for swarm pattern.
 * Blocks coordinator until all agents have completed.
 * Returns 'continue' when all done or when stop_hook_active (prevents loops).
 */
export async function onStop(input: StopInput): Promise<HookOutput> {
  // Prevent infinite loops - if we're already in a stop hook, continue
  if (input.stop_hook_active) {
    return { result: 'continue' };
  }

  const swarmId = process.env.SWARM_ID;

  if (!swarmId) {
    return { result: 'continue' };
  }

  // Validate SWARM_ID format
  if (!isValidId(swarmId)) {
    return { result: 'continue' };
  }

  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  try {
    // Query completion status
    const query = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
swarm_id = sys.argv[2]

conn = sqlite3.connect(db_path)
# Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

# Count agents that have broadcast "done" - these have completed their work
cursor = conn.execute('''
    SELECT COUNT(DISTINCT sender_agent) as done_count
    FROM broadcasts
    WHERE swarm_id = ? AND broadcast_type = 'done'
''', (swarm_id,))
done_count = cursor.fetchone()[0]

# Count total agents - any agent that has ever broadcast anything in this swarm
cursor = conn.execute('''
    SELECT COUNT(DISTINCT sender_agent) as total_count
    FROM broadcasts
    WHERE swarm_id = ?
''', (swarm_id,))
total_count = cursor.fetchone()[0]

conn.close()
print(json.dumps({'done': done_count, 'total': total_count}))
`;

    const result = runPythonQuery(query, [dbPath, swarmId]);

    if (!result.success) {
      return { result: 'continue' };
    }

    // Parse Python output
    let counts: { done: number; total: number };
    try {
      counts = JSON.parse(result.stdout);
    } catch (parseErr) {
      return { result: 'continue' };
    }

    if (counts.done < counts.total) {
      const waiting = counts.total - counts.done;
      return {
        result: 'block',
        message: `Waiting for ${waiting} agent(s) to complete. Synthesize results when all agents broadcast 'done'.`
      };
    }

    return { result: 'continue' };
  } catch (err) {
    console.error('Stop hook error:', err);
    return { result: 'continue' };
  }
}
