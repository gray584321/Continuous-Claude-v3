/**
 * Team Awareness Hook
 *
 * Provides awareness of parallel feature work and session recovery context
 * by querying checkpoints and feature_workspaces tables.
 */

import { spawnSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

interface SessionStartInput {
  session_id: string;
  hook_event_name: string;
  source: 'startup' | 'resume' | 'clear' | 'compact';
  cwd: string;
}

interface Checkpoint {
  id: string;
  session_name: string;
  project: string;
  current_step: string;
  current_task: string;
  goal: string;
  progress: string;
  notes: string;
  created_at: string;
}

interface FeatureWorkspace {
  id: string;
  project: string;
  feature_name: string;
  feature_id: string;
  session_id: string;
  agent_id: string;
  status: string;
  priority: number;
  description: string;
  blockers: string[];
  goals: any[];
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function queryCheckpoints(project: string, sessionId: string): Checkpoint[] {
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

    # Query recent checkpoints for this project
    cursor.execute('''
        SELECT id, session_name, project, current_step, current_task,
               goal, progress, notes, created_at
        FROM checkpoints
        WHERE project = %s
        ORDER BY created_at DESC
        LIMIT 5
    ''', ('${project}',))

    checkpoints = []
    for row in cursor.fetchall():
        checkpoints.append({
            'id': str(row[0]),
            'session_name': row[1],
            'project': row[2],
            'current_step': row[3] or '',
            'current_task': row[4] or '',
            'goal': row[5] or '',
            'progress': row[6] or '',
            'notes': row[7] or '',
            'created_at': row[8].isoformat() if row[8] else ''
        })

    print(json.dumps(checkpoints))

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
    timeout: 10000,
  });

  if (result.status === 0 && result.stdout) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      // Ignore parse errors
    }
  }

  return [];
}

function queryFeatureWorkspaces(project: string): FeatureWorkspace[] {
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

    # Query active feature workspaces for this project
    cursor.execute('''
        SELECT id, project, feature_name, feature_id, session_id,
               agent_id, status, priority, description, blockers, goals
        FROM feature_workspaces
        WHERE project = %s
        ORDER BY priority DESC, created_at DESC
        LIMIT 10
    ''', ('${project}',))

    workspaces = []
    for row in cursor.fetchall():
        workspaces.append({
            'id': str(row[0]),
            'project': row[1],
            'feature_name': row[2],
            'feature_id': row[3],
            'session_id': row[4] or '',
            'agent_id': row[5] or '',
            'status': row[6],
            'priority': row[7],
            'description': row[8] or '',
            'blockers': row[9] or [],
            'goals': row[10] or []
        })

    print(json.dumps(workspaces))

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
    timeout: 10000,
  });

  if (result.status === 0 && result.stdout) {
    try {
      return JSON.parse(result.stdout);
    } catch {
      // Ignore parse errors
    }
  }

  return [];
}

function extractProjectName(projectDir: string): string {
  const parts = projectDir.split('/');
  return parts[parts.length - 1] || 'unknown-project';
}

function formatAwarenessMessage(
  checkpoints: Checkpoint[],
  workspaces: FeatureWorkspace[],
  project: string
): string {
  let message = `## Team Awareness - ${project}\n\n`;

  // Recent checkpoints
  if (checkpoints.length > 0) {
    message += `### Recent Sessions\n\n`;
    for (const checkpoint of checkpoints.slice(0, 3)) {
      message += `**${checkpoint.session_name}**\n`;
      if (checkpoint.goal) {
        message += `- Goal: ${checkpoint.goal}\n`;
      }
      if (checkpoint.current_task) {
        message += `- Current: ${checkpoint.current_task}\n`;
      }
      if (checkpoint.progress) {
        message += `- Progress: ${checkpoint.progress}\n`;
      }
      message += `\n`;
    }
  }

  // Active features
  if (workspaces.length > 0) {
    message += `### Active Features\n\n`;
    for (const workspace of workspaces.slice(0, 5)) {
      const status = workspace.status.toUpperCase();
      const priority = workspace.priority >= 8 ? '🔥' : workspace.priority >= 5 ? '⚡' : '📌';
      message += `${priority} **${workspace.feature_name}** (${status})\n`;
      if (workspace.description) {
        message += `  - ${workspace.description}\n`;
      }
      if (workspace.session_id) {
        message += `  - Session: ${workspace.session_id}\n`;
      }
      if (workspace.blockers && workspace.blockers.length > 0) {
        message += `  - Blockers: ${workspace.blockers.join(', ')}\n`;
      }
      message += `\n`;
    }
  }

  if (checkpoints.length === 0 && workspaces.length === 0) {
    message += `No recent sessions or active features found.`;
  }

  return message;
}

async function main() {
  const input: SessionStartInput = JSON.parse(readStdin());

  // Only run on resume, clear, or compact (expensive queries)
  if (!['resume', 'clear', 'compact'].includes(input.source)) {
    console.log('{}');
    return;
  }

  // Skip for subagents
  if (process.env.CLAUDE_AGENT_ID) {
    console.log('{}');
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  const project = extractProjectName(projectDir);

  try {
    // Query database for awareness information
    const checkpoints = queryCheckpoints(project, input.session_id);
    const workspaces = queryFeatureWorkspaces(project);

    // Format and display awareness message
    const message = formatAwarenessMessage(checkpoints, workspaces, project);

    // Only show if there's actual content
    if (message.length > 50 && (checkpoints.length > 0 || workspaces.length > 0)) {
      console.log('');
      console.log(JSON.stringify({
        result: 'continue',
        hookSpecificOutput: {
          hookEventName: 'TeamAwareness',
          additionalContext: message
        }
      }));
    } else {
      console.log('{}');
    }

  } catch (error) {
    console.log('{}');
  }
}

main().catch((error) => {
  console.error('Team awareness hook error:', error);
  console.log('{}');
});
