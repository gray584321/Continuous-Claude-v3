/**
 * PreCompact Hook: Memory Handoff Preparation
 *
 * On auto-compact, queries recent learnings and core memory,
 * formats for handoff consumption, and stores snapshot.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

interface PreCompactInput {
  session_id: string;
  hook_event_name: string;
  trigger: 'auto' | 'manual';
  cwd: string;
}

interface Learning {
  id: string;
  content: string;
  metadata: any;
  created_at: string;
}

interface CoreMemory {
  key: string;
  value: string;
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function queryRecentLearnings(sessionId: string): Learning[] {
  const opcDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'opc');

  const result = spawnSync('uv', [
    'run',
    'python',
    'scripts/core/recall_learnings.py',
    '--query', 'recent session',
    '--k', '5',
    '--recency', '0.3',
    '--text-only',
    '--json'
  ], {
    encoding: 'utf-8',
    cwd: opcDir,
    env: {
      ...process.env,
      PYTHONPATH: opcDir,
    },
    timeout: 20000,
  });

  if (result.status === 0 && result.stdout) {
    try {
      const output = JSON.parse(result.stdout);
      return output.results || [];
    } catch {
      // Ignore parse errors
    }
  }

  return [];
}

function queryCoreMemory(sessionId: string): CoreMemory[] {
  const opcDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'opc');

  const result = spawnSync('uv', [
    'run',
    'python',
    '-c',
    `
import os
import sys
sys.path.insert(0, '${opcDir}')

from scripts.core.db.memory_factory import create_memory_service
import asyncio

async def get_core_memory():
    memory = await create_memory_service(
        backend='postgres' if os.environ.get('DATABASE_URL') else 'sqlite',
        session_id='${sessionId}'
    )

    try:
        core = await memory.get_core_memory()
        return [(k, v) for k, v in core.items()]
    finally:
        await memory.close()

result = asyncio.run(get_core_memory())
for key, value in result:
    print(f'{key}\\t{value}')
    `
  ], {
    encoding: 'utf-8',
    timeout: 10000,
  });

  if (result.status === 0 && result.stdout) {
    const lines = result.stdout.trim().split('\n').filter(l => l.trim());
    return lines.map(line => {
      const [key, ...valueParts] = line.split('\t');
      return { key, value: valueParts.join('\t') };
    });
  }

  return [];
}

function formatHandoffContext(
  learnings: Learning[],
  coreMemory: CoreMemory[],
  tokenBudget: number = 600
): string {
  let output = '';

  // Header
  output += '## Session Learnings (auto-handoff)\n\n';

  // Recent learnings (last 7 days, high confidence)
  if (learnings.length > 0) {
    output += '### Key Learnings\n';
    for (const learning of learnings.slice(0, 5)) {
      const type = learning.metadata?.learning_type || 'UNKNOWN';
      const confidence = learning.metadata?.confidence || 'medium';
      output += `- [${type}] ${learning.content.slice(0, 150)}${learning.content.length > 150 ? '...' : ''}\n`;
    }
    output += '\n';
  }

  // Core context from memory
  if (coreMemory.length > 0) {
    output += '## Core Context\n';
    for (const mem of coreMemory) {
      // Format key-value pairs nicely
      const key = mem.key.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const value = mem.value.length > 200 ? mem.value.slice(0, 200) + '...' : mem.value;
      output += `- ${key}: ${value}\n`;
    }
    output += '\n';
  }

  // Next steps suggestion
  output += '## Next Steps\n';
  output += '- Review current progress\n';
  output += '- Continue with pending tasks\n';
  output += '- Check for any blockers\n';

  // Truncate if needed to fit token budget (rough estimate: 1 token = 4 chars)
  const maxChars = tokenBudget * 4;
  if (output.length > maxChars) {
    output = output.slice(0, maxChars - 50) + '\n... (truncated)';
  }

  return output;
}

function storeMemorySnapshot(
  sessionId: string,
  learnings: Learning[],
  coreMemory: CoreMemory[],
  handoffContext: string
): boolean {
  const opcDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'opc');

  const result = spawnSync('uv', [
    'run',
    'python',
    '-c',
    `
import os
import sys
import json
sys.path.insert(0, '${opcDir}')

import psycopg2

database_url = os.environ.get('DATABASE_URL')
if not database_url:
    print('DATABASE_URL not set')
    sys.exit(1)

try:
    conn = psycopg2.connect(database_url)
    cursor = conn.cursor()

    # Create session_memory_snapshot table if it doesn't exist
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS session_memory_snapshot (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            session_id TEXT NOT NULL,
            snapshot_type TEXT NOT NULL,
            core_memory_json JSONB,
            top_learnings_json JSONB,
            handoff_context TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    ''')

    # Store snapshot
    cursor.execute('''
        INSERT INTO session_memory_snapshot (
            session_id, snapshot_type, core_memory_json,
            top_learnings_json, handoff_context, created_at
        ) VALUES (%s, %s, %s, %s, %s, NOW())
        RETURNING id
    ''', (
        '${sessionId}',
        'pre_compact',
        json.dumps([{'key': m['key'], 'value': m['value']} for m in ${JSON.stringify(coreMemory)}]),
        json.dumps([{
            'id': l['id'],
            'content': l['content'],
            'metadata': l['metadata']
        } for l in ${JSON.stringify(learnings)}]),
        ${JSON.stringify(handoffContext)}
    ))

    snapshot_id = cursor.fetchone()[0]
    conn.commit()
    print(f'Snapshot stored: {snapshot_id}')

except Exception as e:
    print(f'Error: {e}')
    sys.exit(1)
finally:
    cursor.close()
    conn.close()
    `
  ], {
    encoding: 'utf-8',
    cwd: opcDir,
    env: {
      ...process.env,
      PYTHONPATH: opcDir,
    },
    timeout: 15000,
  });

  return result.status === 0;
}

async function main() {
  const input: PreCompactInput = JSON.parse(readStdin());

  // Only run on auto compact (manual is just informational)
  if (input.trigger !== 'auto') {
    console.log('{}');
    return;
  }

  // Skip for subagents
  if (process.env.CLAUDE_AGENT_ID) {
    console.log('{}');
    return;
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  💾 PREPARING MEMORY HANDOFF                                │');
  console.log('├─────────────────────────────────────────────────────────────┤');

  try {
    // Query recent learnings
    console.log('│  Querying recent learnings...                                 │');
    const learnings = queryRecentLearnings(input.session_id);
    console.log(`│  Found ${learnings.length} recent learnings                        │`);

    // Query core memory
    console.log('│  Querying core memory...                                     │');
    const coreMemory = queryCoreMemory(input.session_id);
    console.log(`│  Found ${coreMemory.length} core memory blocks                     │`);

    // Format for handoff
    console.log('│  Formatting handoff context...                               │');
    const handoffContext = formatHandoffContext(learnings, coreMemory, 600);

    // Store snapshot
    console.log('│  Storing memory snapshot...                                 │');
    const snapshotStored = storeMemorySnapshot(
      input.session_id,
      learnings,
      coreMemory,
      handoffContext
    );

    if (snapshotStored) {
      console.log('│  ✓ Memory snapshot stored                                    │');
    } else {
      console.log('│  ✗ Failed to store snapshot                                │');
    }

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    console.log(JSON.stringify({
      result: 'continue',
      message: `Memory handoff prepared: ${learnings.length} learnings, ${coreMemory.length} core blocks`,
    }));

  } catch (error) {
    console.log('│  Error preparing memory handoff                             │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('{}');
  }
}

main().catch((error) => {
  console.error('Pre-compact memory hook error:', error);
  console.log('{}');
});
