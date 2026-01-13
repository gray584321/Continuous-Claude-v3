// src/shared/db-utils.ts
import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

// src/shared/pattern-router.ts
var SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function isValidId(id) {
  return SAFE_ID_PATTERN.test(id);
}

// src/shared/db-utils.ts
function getDbPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join(
    projectDir,
    ".claude",
    "cache",
    "agentica-coordination",
    "coordination.db"
  );
}
function queryDb(pythonQuery, args) {
  const result = spawnSync("python3", ["-c", pythonQuery, ...args], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    const errorMsg = result.stderr || `Python exited with code ${result.status}`;
    throw new Error(`Python query failed: ${errorMsg}`);
  }
  return result.stdout.trim();
}
function runPythonQuery(script, args) {
  try {
    const result = spawnSync("python3", ["-c", script, ...args], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024
    });
    return {
      success: result.status === 0,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr || ""
    };
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: String(err)
    };
  }
}
function registerAgent(agentId, sessionId, pattern = null, pid = null) {
  const dbPath = getDbPath();
  const source = process.env.AGENTICA_SERVER ? "agentica" : "cli";
  const pythonScript = `
import sqlite3
import sys
import os
from datetime import datetime, timezone
from pathlib import Path

db_path = sys.argv[1]
agent_id = sys.argv[2]
session_id = sys.argv[3]
pattern = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'null' else None
pid = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] != 'null' else None
source = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] != 'null' else None

try:
    # Ensure directory exists
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")

    # Create table if not exists (with source column)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            premise TEXT,
            model TEXT,
            scope_keys TEXT,
            pattern TEXT,
            parent_agent_id TEXT,
            pid INTEGER,
            ppid INTEGER,
            spawned_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT DEFAULT 'running',
            error_message TEXT,
            source TEXT
        )
    """)

    # Migration: add source column if it doesn't exist
    cursor = conn.execute("PRAGMA table_info(agents)")
    columns = {row[1] for row in cursor.fetchall()}
    if 'source' not in columns:
        conn.execute("ALTER TABLE agents ADD COLUMN source TEXT")

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    ppid = os.getppid() if pid else None

    conn.execute(
        """
        INSERT OR REPLACE INTO agents
        (id, session_id, pattern, pid, ppid, spawned_at, status, source)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
        """,
        (agent_id, session_id, pattern, pid, ppid, now, source)
    )
    conn.commit()
    conn.close()
    print("ok")
except Exception as e:
    print(f"error: {e}")
    sys.exit(1)
`;
  const args = [
    dbPath,
    agentId,
    sessionId,
    pattern || "null",
    pid !== null ? String(pid) : "null",
    source
  ];
  const result = runPythonQuery(pythonScript, args);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function completeAgent(agentId, status = "completed", errorMessage = null) {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return { success: true };
  }
  const pythonScript = `
import sqlite3
import sys
from datetime import datetime, timezone

db_path = sys.argv[1]
agent_id = sys.argv[2]
status = sys.argv[3]
error_message = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'null' else None

try:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")

    # Check if agents table exists
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
    )
    if cursor.fetchone() is None:
        print("ok")
        conn.close()
        sys.exit(0)

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

    conn.execute(
        """
        UPDATE agents
        SET completed_at = ?, status = ?, error_message = ?
        WHERE id = ?
        """,
        (now, status, error_message, agent_id)
    )
    conn.commit()
    conn.close()
    print("ok")
except Exception as e:
    print(f"error: {e}")
    sys.exit(1)
`;
  const args = [
    dbPath,
    agentId,
    status,
    errorMessage || "null"
  ];
  const result = runPythonQuery(pythonScript, args);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function detectAndTagSwarm(sessionId) {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return false;
  }
  const pythonScript = `
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

db_path = sys.argv[1]
session_id = sys.argv[2]

try:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")

    # Check if agents table exists
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
    )
    if cursor.fetchone() is None:
        print("no_table")
        conn.close()
        sys.exit(0)

    # Get agents in this session spawned in the last 5 seconds
    # that are still running and have pattern='task' or NULL
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    cutoff = (now - timedelta(seconds=5)).isoformat()

    cursor = conn.execute(
        """
        SELECT id FROM agents
        WHERE session_id = ?
          AND spawned_at > ?
          AND status = 'running'
          AND (pattern = 'task' OR pattern IS NULL)
        """,
        (session_id, cutoff)
    )
    concurrent_agents = cursor.fetchall()

    # If more than 1 concurrent agent, tag all as swarm
    if len(concurrent_agents) > 1:
        agent_ids = [row[0] for row in concurrent_agents]
        placeholders = ','.join('?' * len(agent_ids))
        conn.execute(
            f"UPDATE agents SET pattern = 'swarm' WHERE id IN ({placeholders})",
            agent_ids
        )
        conn.commit()
        print(f"swarm:{len(concurrent_agents)}")
    else:
        print("no_swarm")

    conn.close()
except Exception as e:
    print(f"error: {e}")
    sys.exit(1)
`;
  const result = runPythonQuery(pythonScript, [dbPath, sessionId]);
  if (!result.success) {
    return false;
  }
  return result.stdout.startsWith("swarm:");
}
function getActiveAgentCount() {
  const dbPath = getDbPath();
  if (!existsSync(dbPath)) {
    return 0;
  }
  const pythonScript = `
import sqlite3
import sys
import os

db_path = sys.argv[1]

try:
    # Check if file exists and is a valid SQLite database
    if not os.path.exists(db_path):
        print("0")
        sys.exit(0)

    conn = sqlite3.connect(db_path)
    # Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
    conn.execute("PRAGMA busy_timeout = 5000")
    # Enable WAL mode for better concurrent access
    conn.execute("PRAGMA journal_mode = WAL")

    # Check if agents table exists
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
    )
    if cursor.fetchone() is None:
        print("0")
        conn.close()
        sys.exit(0)

    # Query running agent count
    cursor = conn.execute("SELECT COUNT(*) FROM agents WHERE status = 'running'")
    count = cursor.fetchone()[0]
    conn.close()
    print(count)
except Exception:
    print("0")
`;
  const result = runPythonQuery(pythonScript, [dbPath]);
  if (!result.success) {
    return 0;
  }
  const count = parseInt(result.stdout, 10);
  return isNaN(count) ? 0 : count;
}
export {
  SAFE_ID_PATTERN,
  completeAgent,
  detectAndTagSwarm,
  getActiveAgentCount,
  getDbPath,
  isValidId,
  queryDb,
  registerAgent,
  runPythonQuery
};
