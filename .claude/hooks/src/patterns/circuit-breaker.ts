/**
 * Unified Circuit Breaker Pattern Handlers
 *
 * Implements circuit breaker coordination logic for failure detection and fallback routing:
 * - onSubagentStart: Inject primary/fallback role context
 * - onSubagentStop: Track success/failure for circuit state
 * - onPostToolUse: Detect failures from tool responses
 * - onStop: Circuit state summary
 *
 * Environment Variables:
 * - CB_ID: Circuit breaker identifier (required for circuit breaker operations)
 * - AGENT_ROLE: Role of this agent (primary or fallback)
 * - CIRCUIT_STATE: Current circuit state (closed, open, half_open)
 * - CLAUDE_PROJECT_DIR: Project directory for DB path
 *
 * Adaptive Threshold Configuration (via environment or DB):
 * - CB_INITIAL_THRESHOLD: Initial failure count (default: 3)
 * - CB_MIN_THRESHOLD: Minimum threshold (default: 1)
 * - CB_MAX_THRESHOLD: Maximum threshold (default: 10)
 * - CB_ADAPTATION_RATE: How fast to adapt (0.0-1.0, default: 0.2)
 * - CB_WINDOW_SIZE: Time window in ms (default: 60000 = 1 minute)
 */

import { existsSync } from 'fs';

// Import shared utilities
import { getDbPath, runPythonQuery, isValidId, publishCircuitEvent } from '../shared/db-utils.js';
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
// Circuit Breaker State Types
// =============================================================================

/**
 * Circuit state enumeration
 */
export enum CircuitState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half-open'
}

/**
 * Configuration for adaptive circuit breaker
 */
export interface AdaptiveCircuitBreakerConfig {
  initialThreshold: number;   // Initial failure count to open circuit
  minThreshold: number;       // Never go below this
  maxThreshold: number;       // Never go above this
  adaptationRate: number;     // How fast to adapt (0.0-1.0)
  windowSize: number;         // Time window in ms for metrics
}

/**
 * Circuit breaker metrics for monitoring
 */
export interface CircuitBreakerMetrics {
  failureRate: number;         // Current failure rate (0.0-1.0)
  currentThreshold: number;    // Current adaptive threshold
  state: CircuitState;         // Current circuit state
  totalFailures: number;       // Total failures in window
  totalSuccesses: number;      // Total successes in window
  windowStartTime: string;     // When the current window started
  adaptiveInfo: {
    minThreshold: number;
    maxThreshold: number;
    adaptationRate: number;
  };
}

/**
 * Default configuration for adaptive circuit breaker
 */
export const DEFAULT_CB_CONFIG: AdaptiveCircuitBreakerConfig = {
  initialThreshold: 3,
  minThreshold: 1,
  maxThreshold: 10,
  adaptationRate: 0.2,
  windowSize: 60000 // 1 minute
};

// =============================================================================
// onSubagentStart Handler
// =============================================================================

/**
 * Handles SubagentStart hook for circuit breaker pattern.
 * Injects primary/fallback role context and circuit state information.
 * Always returns 'continue' - never blocks agent start.
 */
export async function onSubagentStart(input: SubagentStartInput): Promise<HookOutput> {
  const cbId = process.env.CB_ID;

  // If no CB_ID, continue silently (not in a circuit breaker)
  if (!cbId) {
    return { result: 'continue' };
  }

  // Validate CB_ID format
  if (!isValidId(cbId)) {
    return { result: 'continue' };
  }

  const role = process.env.AGENT_ROLE || 'primary';
  const circuitState = process.env.CIRCUIT_STATE || 'closed';

  // Log for debugging - this goes to stderr, not stdout
  console.error(`[circuit-breaker] Agent role=${role} state=${circuitState} cb_id=${cbId}`);

  // Inject role-specific context message
  let message = '';

  if (role === 'primary') {
    message = `You are the PRIMARY agent in a circuit breaker pattern (circuit state: ${circuitState}).`;
    message += ' Your execution is monitored for failures.';

    if (circuitState === 'half-open') {
      message += ' TESTING MODE: The circuit is testing if you have recovered. A single failure will reopen the circuit.';
    } else if (circuitState === 'closed') {
      message += ' Normal operation - consecutive failures will open the circuit and route to fallback.';
    }
  } else if (role === 'fallback') {
    message = `You are the FALLBACK agent in a circuit breaker pattern.`;
    message += ' You are operating in degraded mode as a backup to the primary agent.';
    message += ' Provide a simpler or safer implementation.';
  }

  return {
    result: 'continue',
    message
  };
}

// =============================================================================
// onSubagentStop Handler
// =============================================================================

/**
 * Handles SubagentStop hook for circuit breaker pattern.
 * Records success/failure in database to track circuit state.
 */
export async function onSubagentStop(input: SubagentStopInput): Promise<HookOutput> {
  const cbId = process.env.CB_ID;

  // If no CB_ID, continue silently
  if (!cbId) {
    return { result: 'continue' };
  }

  // Validate CB_ID format
  if (!isValidId(cbId)) {
    return { result: 'continue' };
  }

  const agentId = input.agent_id ?? 'unknown';

  // Validate agent_id format
  if (!isValidId(agentId)) {
    return { result: 'continue' };
  }

  const role = process.env.AGENT_ROLE || 'primary';
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  try {
    // Get current circuit state with adaptive metrics
    const query = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
cb_id = sys.argv[2]

conn = sqlite3.connect(db_path)
# Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

# Create enhanced table with adaptive thresholds if not exists
conn.execute('''
    CREATE TABLE IF NOT EXISTS circuit_state (
        id TEXT PRIMARY KEY,
        cb_id TEXT NOT NULL UNIQUE,
        state TEXT DEFAULT 'closed',
        failure_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        current_threshold INTEGER DEFAULT 3,
        window_start TEXT,
        last_failure_at TEXT,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
''')

# Get current circuit state
cursor = conn.execute('''
    SELECT state, failure_count, success_count, current_threshold, window_start
    FROM circuit_state
    WHERE cb_id = ?
''', (cb_id,))
row = cursor.fetchone()

if row:
    state, failure_count, success_count, current_threshold, window_start = row
else:
    state = 'closed'
    failure_count = 0
    success_count = 0
    current_threshold = 3
    window_start = None

conn.close()
print(json.dumps({
    'state': state,
    'failure_count': failure_count,
    'success_count': success_count,
    'current_threshold': current_threshold,
    'window_start': window_start
}))
`;

    const result = runPythonQuery(query, [dbPath, cbId]);

    if (!result.success) {
      console.error('SubagentStop Python error:', result.stderr);
      return { result: 'continue' };
    }

    // Parse Python output
    let state: {
      state: string;
      failure_count: number;
      success_count: number;
      current_threshold: number;
      window_start: string | null;
    };
    try {
      state = JSON.parse(result.stdout);
    } catch (parseErr) {
      return { result: 'continue' };
    }

    // Log for debugging
    console.error(`[circuit-breaker] Agent ${agentId} (${role}) completed. Circuit state: ${state.state} (failures: ${state.failure_count}, successes: ${state.success_count}, threshold: ${state.current_threshold})`);

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
 * Handles PreToolUse hook for circuit breaker pattern.
 * Currently no-op - circuit breaker doesn't restrict tool usage.
 */
export async function onPreToolUse(input: PreToolUseInput): Promise<HookOutput> {
  // No special handling needed for circuit breaker pattern
  return { result: 'continue' };
}

// =============================================================================
// onPostToolUse Handler
// =============================================================================

/**
 * Handles PostToolUse hook for circuit breaker pattern.
 * Detects failures from tool responses and updates adaptive thresholds.
 */
export async function onPostToolUse(input: PostToolUseInput): Promise<HookOutput> {
  const cbId = process.env.CB_ID;

  // If no CB_ID, continue silently
  if (!cbId) {
    return { result: 'continue' };
  }

  // Validate CB_ID format
  if (!isValidId(cbId)) {
    return { result: 'continue' };
  }

  const role = process.env.AGENT_ROLE || 'primary';

  // Only track primary agent failures (fallback is expected to succeed)
  if (role !== 'primary') {
    return { result: 'continue' };
  }

  const toolName = input.tool_name;
  const toolResponse = input.tool_response || {};

  // Detect failure patterns in tool responses
  let hasFailure = false;

  // Bash failures: non-zero exit code
  if (toolName === 'Bash' && typeof toolResponse === 'object') {
    const exitCode = (toolResponse as any).exit_code;
    if (typeof exitCode === 'number' && exitCode !== 0) {
      hasFailure = true;
    }
  }

  // Read failures: error in response
  if (toolName === 'Read' && typeof toolResponse === 'object') {
    const error = (toolResponse as any).error;
    if (error) {
      hasFailure = true;
    }
  }

  // Other tool errors
  if (typeof toolResponse === 'object' && (toolResponse as any).error) {
    hasFailure = true;
  }

  // Record result in database
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  try {
    if (hasFailure) {
      // Record failure with adaptive threshold logic
      const failureQuery = `
import sqlite3
import json
import sys
from datetime import datetime, timezone

db_path = sys.argv[1]
cb_id = sys.argv[2]
tool_name = sys.argv[3]

# Adaptive configuration (could be loaded from environment or config table)
initial_threshold = 3
min_threshold = 1
max_threshold = 10
adaptation_rate = 0.2
window_size_ms = 60000  # 1 minute

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

# Create enhanced table with adaptive thresholds
conn.execute('''
    CREATE TABLE IF NOT EXISTS circuit_state (
        id TEXT PRIMARY KEY,
        cb_id TEXT NOT NULL UNIQUE,
        state TEXT DEFAULT 'closed',
        failure_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        current_threshold INTEGER DEFAULT 3,
        window_start TEXT,
        last_failure_at TEXT,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
''')

now = datetime.now(timezone.utc)
now_iso = now.isoformat()

# Get current state
cursor = conn.execute('''
    SELECT state, failure_count, success_count, current_threshold, window_start
    FROM circuit_state
    WHERE cb_id = ?
''', (cb_id,))
row = cursor.fetchone()

if row:
    current_state, failure_count, success_count, current_threshold, window_start = row
    # Check if window has expired
    if window_start:
        window_dt = datetime.fromisoformat(window_start.replace('+00:00', '+00:00'))
        if (now - window_dt).total_seconds() * 1000 > window_size_ms:
            # Reset window - start new measurement period
            failure_count = 0
            success_count = 0
            window_start = now_iso
    else:
        window_start = now_iso
else:
    current_state = 'closed'
    failure_count = 0
    success_count = 0
    current_threshold = initial_threshold
    window_start = now_iso

# Increment failure count
new_failure_count = failure_count + 1
new_last_failure_at = now_iso

# Calculate failure rate
total_count = new_failure_count + success_count
failure_rate = new_failure_count / total_count if total_count > 0 else 0.0

# Adapt threshold based on failure rate
if failure_rate > 0.5:
    # High failure rate - lower threshold (more sensitive)
    new_threshold = max(
        min_threshold,
        current_threshold - adaptation_rate * current_threshold
    )
else:
    # Low failure rate - raise threshold (more tolerant)
    new_threshold = min(
        max_threshold,
        current_threshold + adaptation_rate * (1 - failure_rate) * current_threshold
    )
new_threshold = max(1, int(round(new_threshold)))

# Determine new state
if current_state == 'closed':
    if new_failure_count >= new_threshold:
        new_state = 'open'
    else:
        new_state = 'closed'
elif current_state == 'half-open':
    # Any failure during half-open reopens the circuit
    new_state = 'open'
else:  # open
    # Stay open until reset timeout
    new_state = 'open'

# Upsert circuit state
conn.execute('''
    INSERT OR REPLACE INTO circuit_state
    (id, cb_id, state, failure_count, success_count, current_threshold,
     window_start, last_failure_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM circuit_state WHERE cb_id = ?), ?), ?)
''', (
    cb_id, cb_id, new_state, new_failure_count, success_count, new_threshold,
    window_start, new_last_failure_at, cb_id, now_iso, now_iso
))
conn.commit()

conn.close()
print(json.dumps({
    'state': new_state,
    'failure_count': new_failure_count,
    'success_count': success_count,
    'current_threshold': new_threshold,
    'failure_rate': round(failure_rate, 4),
    'window_start': window_start
}))
`;

      const result = runPythonQuery(failureQuery, [dbPath, cbId, toolName]);

      if (!result.success) {
        console.error('PostToolUse Python error:', result.stderr);
        return { result: 'continue' };
      }

      // Parse result
      let stateData: {
        state: string;
        failure_count: number;
        success_count: number;
        current_threshold: number;
        failure_rate: number;
      };
      try {
        stateData = JSON.parse(result.stdout);
        console.error(`[circuit-breaker] Recorded failure for ${toolName}. State: ${stateData.state}, threshold: ${stateData.current_threshold}, failure_rate: ${stateData.failure_rate}`);
      } catch {
        console.error(`[circuit-breaker] Detected ${toolName} failure for cb_id=${cbId}`);
      }
    } else {
      // Record success - update metrics and potentially reset state
      const successQuery = `
import sqlite3
import json
import sys
from datetime import datetime, timezone

db_path = sys.argv[1]
cb_id = sys.argv[2]

# Adaptive configuration
initial_threshold = 3
min_threshold = 1
max_threshold = 10
adaptation_rate = 0.2
window_size_ms = 60000

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

conn.execute('''
    CREATE TABLE IF NOT EXISTS circuit_state (
        id TEXT PRIMARY KEY,
        cb_id TEXT NOT NULL UNIQUE,
        state TEXT DEFAULT 'closed',
        failure_count INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        current_threshold INTEGER DEFAULT 3,
        window_start TEXT,
        last_failure_at TEXT,
        last_success_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    )
''')

now = datetime.now(timezone.utc)
now_iso = now.isoformat()

# Get current state
cursor = conn.execute('''
    SELECT state, failure_count, success_count, current_threshold, window_start
    FROM circuit_state
    WHERE cb_id = ?
''', (cb_id,))
row = cursor.fetchone()

if row:
    current_state, failure_count, success_count, current_threshold, window_start = row
    # Check if window has expired
    if window_start:
        try:
            window_dt = datetime.fromisoformat(window_start.replace('+00:00', '+00:00'))
            if (now - window_dt).total_seconds() * 1000 > window_size_ms:
                failure_count = 0
                success_count = 0
                window_start = now_iso
        except:
            window_start = now_iso
    else:
        window_start = now_iso
else:
    current_state = 'closed'
    failure_count = 0
    success_count = 0
    current_threshold = initial_threshold
    window_start = now_iso

# Increment success count
new_success_count = success_count + 1
new_last_success_at = now_iso

# Calculate failure rate
total_count = failure_count + new_success_count
failure_rate = failure_count / total_count if total_count > 0 else 0.0

# Adapt threshold on success too - make it more tolerant
if failure_rate <= 0.5:
    # Low failure rate - can be more tolerant
    new_threshold = min(
        max_threshold,
        current_threshold + adaptation_rate * (1 - failure_rate) * current_threshold
    )
else:
    new_threshold = current_threshold
new_threshold = max(min_threshold, int(round(new_threshold)))

# Determine new state
if current_state == 'open':
    # Success during open state transitions to half-open for testing
    new_state = 'half-open'
elif current_state == 'half-open':
    # Success during half-open - close the circuit
    new_state = 'closed'
    # Reset failure count on successful recovery
    failure_count = 0
else:  # closed
    # Stay closed, adapt threshold
    new_state = 'closed'

# Upsert circuit state
conn.execute('''
    INSERT OR REPLACE INTO circuit_state
    (id, cb_id, state, failure_count, success_count, current_threshold,
     window_start, last_success_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE((SELECT created_at FROM circuit_state WHERE cb_id = ?), ?), ?)
''', (
    cb_id, cb_id, new_state, failure_count, new_success_count, new_threshold,
    window_start, new_last_success_at, cb_id, now_iso, now_iso
))
conn.commit()

conn.close()
print(json.dumps({
    'state': new_state,
    'failure_count': failure_count,
    'success_count': new_success_count,
    'current_threshold': new_threshold,
    'failure_rate': round(failure_rate, 4),
    'window_start': window_start
}))
`;

      const result = runPythonQuery(successQuery, [dbPath, cbId]);

      if (!result.success) {
        console.error('PostToolUse Python error:', result.stderr);
        return { result: 'continue' };
      }

      // Parse result
      let stateData: {
        state: string;
        failure_count: number;
        success_count: number;
        current_threshold: number;
        failure_rate: number;
      };
      try {
        stateData = JSON.parse(result.stdout);
        if (stateData.state === 'half-open') {
          console.error(`[circuit-breaker] Circuit transitioned to HALF-OPEN for recovery testing. Threshold: ${stateData.current_threshold}`);
        } else if (stateData.state === 'closed' && stateData.failure_count === 0) {
          console.error(`[circuit-breaker] Circuit CLOSED after successful recovery. Threshold: ${stateData.current_threshold}`);
        }
      } catch {
        // Ignore parse errors
      }
    }

    return { result: 'continue' };
  } catch (err) {
    console.error('PostToolUse hook error:', err);
    return { result: 'continue' };
  }
}

// =============================================================================
// onStop Handler
// =============================================================================

/**
 * Handles Stop hook for circuit breaker pattern.
 * Provides circuit state summary with metrics when coordinator completes.
 */
export async function onStop(input: StopInput): Promise<HookOutput> {
  // Prevent infinite loops - if we're already in a stop hook, continue
  if (input.stop_hook_active) {
    return { result: 'continue' };
  }

  const cbId = process.env.CB_ID;

  if (!cbId) {
    return { result: 'continue' };
  }

  // Validate CB_ID format
  if (!isValidId(cbId)) {
    return { result: 'continue' };
  }

  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return { result: 'continue' };
  }

  try {
    // Query circuit state with full metrics
    const query = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
cb_id = sys.argv[2]

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout = 5000")
conn.execute("PRAGMA journal_mode = WAL")

# Get circuit state with all metrics
cursor = conn.execute('''
    SELECT state, failure_count, success_count, current_threshold, window_start, last_failure_at, last_success_at
    FROM circuit_state
    WHERE cb_id = ?
''', (cb_id,))
row = cursor.fetchone()

if row:
    state, failure_count, success_count, current_threshold, window_start, last_failure_at, last_success_at = row
else:
    state = 'closed'
    failure_count = 0
    success_count = 0
    current_threshold = 3
    window_start = None
    last_failure_at = None
    last_success_at = None

total = failure_count + success_count
failure_rate = failure_count / total if total > 0 else 0.0

conn.close()
print(json.dumps({
    'state': state,
    'failure_count': failure_count,
    'success_count': success_count,
    'current_threshold': current_threshold,
    'failure_rate': round(failure_rate, 4),
    'window_start': window_start,
    'last_failure_at': last_failure_at,
    'last_success_at': last_success_at,
    'adaptive_info': {
        'min_threshold': 1,
        'max_threshold': 10,
        'adaptation_rate': 0.2
    }
}))
`;

    const result = runPythonQuery(query, [dbPath, cbId]);

    if (!result.success) {
      return { result: 'continue' };
    }

    // Parse Python output
    let data: {
      state: string;
      failure_count: number;
      success_count: number;
      current_threshold: number;
      failure_rate: number;
      window_start: string | null;
      last_failure_at: string | null;
      last_success_at: string | null;
      adaptive_info: {
        min_threshold: number;
        max_threshold: number;
        adaptation_rate: number;
      };
    };
    try {
      data = JSON.parse(result.stdout);
    } catch (parseErr) {
      return { result: 'continue' };
    }

    // Provide comprehensive circuit state summary with metrics
    let message = `Circuit Breaker Summary (ID: ${cbId}):\n`;
    message += `  State: ${data.state.toUpperCase()}\n`;
    message += `  Failures: ${data.failure_count}\n`;
    message += `  Successes: ${data.success_count}\n`;
    message += `  Failure Rate: ${(data.failure_rate * 100).toFixed(1)}%\n`;
    message += `  Current Threshold: ${data.current_threshold}\n`;
    message += `  Adaptive Range: [${data.adaptive_info.min_threshold} - ${data.adaptive_info.max_threshold}]\n`;

    if (data.window_start) {
      message += `  Window Start: ${data.window_start}\n`;
    }

    message += '\n';

    if (data.state === 'open') {
      message += 'WARNING: Circuit is OPEN due to repeated failures. Fallback agent is being used.\n';
      message += 'The circuit will automatically test the primary agent after the reset timeout.\n';
      message += `Adaptive threshold adjusted to ${data.current_threshold} based on failure rate.`;
    } else if (data.state === 'half-open') {
      message += 'INFO: Circuit is in HALF-OPEN state, testing if primary agent has recovered.\n';
      message += 'A success will close the circuit; a failure will reopen it.';
    } else {
      message += 'INFO: Circuit is CLOSED, primary agent is operating normally.\n';
      if (data.failure_rate > 0) {
        message += `Current threshold is ${data.current_threshold} (adapted from defaults based on failure rate).`;
      }
    }

    return {
      result: 'continue',
      message
    };
  } catch (err) {
    console.error('Stop hook error:', err);
    return { result: 'continue' };
  }
}

// =============================================================================
// Utility Functions for External Use
// =============================================================================

/**
 * Get current circuit breaker metrics
 * Returns metrics for monitoring and debugging
 */
export async function getCircuitBreakerMetrics(cbId: string): Promise<CircuitBreakerMetrics | null> {
  const dbPath = getDbPath();

  if (!existsSync(dbPath)) {
    return null;
  }

  const query = `
import sqlite3
import json
import sys

db_path = sys.argv[1]
cb_id = sys.argv[2]

conn = sqlite3.connect(db_path)
conn.execute("PRAGMA busy_timeout = 5000")

cursor = conn.execute('''
    SELECT state, failure_count, success_count, current_threshold, window_start
    FROM circuit_state
    WHERE cb_id = ?
''', (cb_id,))
row = cursor.fetchone()

if row:
    state, failure_count, success_count, current_threshold, window_start = row
else:
    state = 'closed'
    failure_count = 0
    success_count = 0
    current_threshold = 3
    window_start = None

total = failure_count + success_count
failure_rate = failure_count / total if total > 0 else 0.0

conn.close()
print(json.dumps({
    'failureRate': round(failure_rate, 4),
    'currentThreshold': current_threshold,
    'state': state,
    'totalFailures': failure_count,
    'totalSuccesses': success_count,
    'windowStartTime': window_start,
    'adaptiveInfo': {
        'minThreshold': 1,
        'maxThreshold': 10,
        'adaptationRate': 0.2
    }
}))
`;

  const result = runPythonQuery(query, [dbPath, cbId]);

  if (!result.success) {
    return null;
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Transition circuit state with event publishing
 */
export async function transitionCircuitState(
  cbId: string,
  fromState: CircuitState,
  toState: CircuitState
): Promise<void> {
  // Publish circuit event for monitoring
  await publishCircuitEvent({
    cb_id: cbId,
    from_state: fromState,
    to_state: toState,
    timestamp: new Date().toISOString()
  });
}
