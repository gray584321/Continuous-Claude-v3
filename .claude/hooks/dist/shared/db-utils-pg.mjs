// src/shared/db-utils-pg.ts
import { spawnSync } from "child_process";

// src/shared/opc-path.ts
import { existsSync } from "fs";
import { join } from "path";
function getOpcDir() {
  const envOpcDir = process.env.CLAUDE_OPC_DIR;
  if (envOpcDir && existsSync(envOpcDir)) {
    return envOpcDir;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const localOpc = join(projectDir, "opc");
  if (existsSync(localOpc)) {
    return localOpc;
  }
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";
  if (homeDir) {
    const globalClaude = join(homeDir, ".claude");
    const globalScripts = join(globalClaude, "scripts", "core");
    if (existsSync(globalScripts)) {
      return globalClaude;
    }
  }
  return null;
}
function requireOpcDir() {
  const opcDir = getOpcDir();
  if (!opcDir) {
    console.log(JSON.stringify({ result: "continue" }));
    process.exit(0);
  }
  return opcDir;
}

// src/shared/pattern-router.ts
var SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function isValidId(id) {
  return SAFE_ID_PATTERN.test(id);
}

// src/shared/db-utils-pg.ts
function getPgConnectionString() {
  return process.env.OPC_POSTGRES_URL || process.env.DATABASE_URL || "postgresql://claude:claude_dev@localhost:5432/continuous_claude";
}
function runPgQuery(pythonCode, args = []) {
  const opcDir = requireOpcDir();
  const wrappedCode = `
import sys
import os
import asyncio
import json

# Add opc to path for imports
sys.path.insert(0, '${opcDir}')
os.chdir('${opcDir}')

${pythonCode}
`;
  try {
    const result = spawnSync("uv", ["run", "python", "-c", wrappedCode, ...args], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
      cwd: opcDir,
      env: {
        ...process.env,
        OPC_POSTGRES_URL: getPgConnectionString()
      }
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
function queryBroadcasts(swarmId, agentId, limit = 10) {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

swarm_id = sys.argv[1]
agent_id = sys.argv[2]
limit = int(sys.argv[3])

async def main():
    async with CoordinationDBPg() as db:
        # Query blackboard for messages this agent hasn't read
        messages = await db.read_from_blackboard(swarm_id, agent_id)

        # Limit results
        messages = messages[:limit]

        # Convert to JSON-serializable format
        result = []
        for msg in messages:
            result.append({
                'sender': msg.sender_agent,
                'type': msg.message_type,
                'payload': msg.payload,
                'time': msg.created_at.isoformat() if msg.created_at else None
            })

        print(json.dumps(result))

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [swarmId, agentId, String(limit)]);
  if (!result.success) {
    return { success: false, broadcasts: [] };
  }
  try {
    const broadcasts = JSON.parse(result.stdout || "[]");
    return { success: true, broadcasts };
  } catch {
    return { success: false, broadcasts: [] };
  }
}
function queryPipelineArtifacts(pipelineId, currentStage) {
  const pythonCode = `
import asyncpg
import json
import os

pipeline_id = sys.argv[1]
current_stage = int(sys.argv[2])
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Query pipeline artifacts from upstream stages
        rows = await conn.fetch('''
            SELECT stage_index, artifact_type, artifact_path, artifact_content, created_at
            FROM pipeline_artifacts
            WHERE pipeline_id = $1 AND stage_index < $2
            ORDER BY stage_index ASC, created_at DESC
        ''', pipeline_id, current_stage)

        artifacts = []
        for row in rows:
            artifacts.append({
                'stage': row['stage_index'],
                'type': row['artifact_type'],
                'path': row['artifact_path'],
                'content': row['artifact_content'],
                'time': row['created_at'].isoformat() if row['created_at'] else None
            })

        print(json.dumps(artifacts))
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [pipelineId, String(currentStage)]);
  if (!result.success) {
    return { success: false, artifacts: [] };
  }
  try {
    const artifacts = JSON.parse(result.stdout || "[]");
    return { success: true, artifacts };
  } catch {
    return { success: false, artifacts: [] };
  }
}
function getActiveAgentCountPg() {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

async def main():
    async with CoordinationDBPg() as db:
        agents = await db.get_running_agents()
        print(len(agents))

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode);
  if (!result.success) {
    return 0;
  }
  const count = parseInt(result.stdout, 10);
  return isNaN(count) ? 0 : count;
}
function registerAgentPg(agentId, sessionId, pattern = null, pid = null) {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

agent_id = sys.argv[1]
session_id = sys.argv[2]
pattern = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'null' else None
pid = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4] != 'null' else None

async def main():
    try:
        async with CoordinationDBPg() as db:
            await db.register_agent(
                agent_id=agent_id,
                session_id=session_id,
                pattern=pattern,
                pid=pid
            )
        print('ok')
    except Exception as e:
        print(f'error: {e}')

asyncio.run(main())
`;
  const args = [
    agentId,
    sessionId,
    pattern || "null",
    pid !== null ? String(pid) : "null"
  ];
  const result = runPgQuery(pythonCode, args);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function completeAgentPg(agentId, status = "completed", errorMessage = null) {
  const pythonCode = `
from scripts.agentica_patterns.coordination_pg import CoordinationDBPg
import json

agent_id = sys.argv[1]
status = sys.argv[2]
error_message = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != 'null' else None

async def main():
    try:
        async with CoordinationDBPg() as db:
            await db.complete_agent(
                agent_id=agent_id,
                status=status,
                result_summary=error_message
            )
        print('ok')
    except Exception as e:
        print(f'error: {e}')

asyncio.run(main())
`;
  const args = [
    agentId,
    status,
    errorMessage || "null"
  ];
  const result = runPgQuery(pythonCode, args);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function registerSession(sessionId, project, workingOn = "") {
  const pythonCode = `
import asyncpg
import os
from datetime import datetime

session_id = sys.argv[1]
project = sys.argv[2]
working_on = sys.argv[3] if len(sys.argv) > 3 else ''
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Upsert session
        await conn.execute('''
            INSERT INTO sessions (id, project, working_on, started_at, last_heartbeat)
            VALUES ($1, $2, $3, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
                working_on = EXCLUDED.working_on,
                last_heartbeat = NOW()
        ''', session_id, project, working_on)

        print('ok')
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [sessionId, project, workingOn]);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function getActiveSessions(project) {
  const pythonCode = `
import asyncpg
import os
import json
from datetime import datetime, timedelta

project_filter = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] != 'null' else None
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Get sessions active in last 5 minutes
        cutoff = datetime.utcnow() - timedelta(minutes=5)

        if project_filter:
            rows = await conn.fetch('''
                SELECT id, project, working_on, started_at, last_heartbeat
                FROM sessions
                WHERE project = $1 AND last_heartbeat > $2
                ORDER BY started_at DESC
            ''', project_filter, cutoff)
        else:
            rows = await conn.fetch('''
                SELECT id, project, working_on, started_at, last_heartbeat
                FROM sessions
                WHERE last_heartbeat > $1
                ORDER BY started_at DESC
            ''', cutoff)

        sessions = []
        for row in rows:
            sessions.append({
                'id': row['id'],
                'project': row['project'],
                'working_on': row['working_on'],
                'started_at': row['started_at'].isoformat() if row['started_at'] else None,
                'last_heartbeat': row['last_heartbeat'].isoformat() if row['last_heartbeat'] else None
            })

        print(json.dumps(sessions))
    except Exception as e:
        print(json.dumps([]))
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [project || "null"]);
  if (!result.success) {
    return { success: false, sessions: [] };
  }
  try {
    const sessions = JSON.parse(result.stdout || "[]");
    return { success: true, sessions };
  } catch {
    return { success: false, sessions: [] };
  }
}
function checkFileClaim(filePath, project, mySessionId) {
  const pythonCode = `
import asyncpg
import os
import json

file_path = sys.argv[1]
project = sys.argv[2]
my_session_id = sys.argv[3]
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        row = await conn.fetchrow('''
            SELECT session_id, claimed_at FROM file_claims
            WHERE file_path = $1 AND project = $2 AND session_id != $3
        ''', file_path, project, my_session_id)

        if row:
            print(json.dumps({
                'claimed': True,
                'claimedBy': row['session_id'],
                'claimedAt': row['claimed_at'].isoformat() if row['claimed_at'] else None
            }))
        else:
            print(json.dumps({'claimed': False}))
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [filePath, project, mySessionId]);
  if (!result.success) {
    return { claimed: false };
  }
  try {
    return JSON.parse(result.stdout || '{"claimed": false}');
  } catch {
    return { claimed: false };
  }
}
function claimFile(filePath, project, sessionId) {
  const pythonCode = `
import asyncpg
import os

file_path = sys.argv[1]
project = sys.argv[2]
session_id = sys.argv[3]
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        await conn.execute('''
            INSERT INTO file_claims (file_path, project, session_id, claimed_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (file_path, project) DO UPDATE SET
                session_id = EXCLUDED.session_id,
                claimed_at = NOW()
        ''', file_path, project, session_id)
        print('ok')
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [filePath, project, sessionId]);
  return { success: result.success && result.stdout === "ok" };
}
function claimFileAtomic(filePath, project, sessionId) {
  const pythonCode = `
import asyncpg
import os

file_path = sys.argv[1]
project = sys.argv[2]
session_id = sys.argv[3]
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Atomically insert or update, returning the session_id that was written
        result = await conn.fetchrow('''
            INSERT INTO file_claims (file_path, project, session_id, claimed_at)
            VALUES ($1, $2, $3, NOW())
            ON CONFLICT (file_path, project) DO UPDATE SET
                session_id = EXCLUDED.session_id,
                claimed_at = NOW()
            RETURNING session_id
        ''', file_path, project, session_id)

        # If the returned session_id matches our session_id, we own the claim
        if result['session_id'] == session_id:
            print('claimed:true')
        else:
            # Someone else claimed it - return their session_id
            print(f'claimed:false:claimed_by:{result["session_id"]}')
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [filePath, project, sessionId]);
  if (!result.success) {
    return { claimed: false };
  }
  const output = result.stdout.trim();
  if (output === "claimed:true") {
    return { claimed: true };
  } else if (output.startsWith("claimed:false:claimed_by:")) {
    const claimedBy = output.split(":claimed_by:")[1];
    return { claimed: false, claimedBy };
  }
  return { claimed: false };
}
function broadcastFinding(sessionId, topic, finding, relevantTo = []) {
  const pythonCode = `
import asyncpg
import os
import json

session_id = sys.argv[1]
topic = sys.argv[2]
finding = sys.argv[3]
relevant_to = json.loads(sys.argv[4]) if len(sys.argv) > 4 else []
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        await conn.execute('''
            INSERT INTO findings (session_id, topic, finding, relevant_to)
            VALUES ($1, $2, $3, $4)
        ''', session_id, topic, finding, relevant_to)
        print('ok')
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [
    sessionId,
    topic,
    finding,
    JSON.stringify(relevantTo)
  ]);
  return { success: result.success && result.stdout === "ok" };
}
function getRelevantFindings(query, excludeSessionId, limit = 5) {
  const pythonCode = `
import asyncpg
import os
import json

query = sys.argv[1]
exclude_session = sys.argv[2]
limit = int(sys.argv[3])
pg_url = os.environ.get('OPC_POSTGRES_URL', 'postgresql://claude:claude_dev@localhost:5432/continuous_claude')

async def main():
    conn = await asyncpg.connect(pg_url)
    try:
        # Use parameterized query to prevent SQL injection
        search_pattern = f'%{query}%'
        rows = await conn.fetch('''
            SELECT session_id, topic, finding, relevant_to, created_at
            FROM findings
            WHERE session_id != $1
              AND (topic ILIKE $4
                   OR $4 = ANY(relevant_to)
                   OR finding ILIKE $5)
            ORDER BY created_at DESC
            LIMIT $3
        ''', exclude_session, query, limit, search_pattern, search_pattern)

        findings = []
        for row in rows:
            findings.append({
                'session_id': row['session_id'],
                'topic': row['topic'],
                'finding': row['finding'],
                'relevant_to': row['relevant_to'],
                'created_at': row['created_at'].isoformat() if row['created_at'] else None
            })

        print(json.dumps(findings))
    except Exception as e:
        print(json.dumps([]))
    finally:
        await conn.close()

asyncio.run(main())
`;
  const result = runPgQuery(pythonCode, [query, excludeSessionId, String(limit)]);
  if (!result.success) {
    return { success: false, findings: [] };
  }
  try {
    const findings = JSON.parse(result.stdout || "[]");
    return { success: true, findings };
  } catch {
    return { success: false, findings: [] };
  }
}
export {
  SAFE_ID_PATTERN,
  broadcastFinding,
  checkFileClaim,
  claimFile,
  claimFileAtomic,
  completeAgentPg,
  getActiveAgentCountPg,
  getActiveSessions,
  getPgConnectionString,
  getRelevantFindings,
  isValidId,
  queryBroadcasts,
  queryPipelineArtifacts,
  registerAgentPg,
  registerSession,
  runPgQuery
};
