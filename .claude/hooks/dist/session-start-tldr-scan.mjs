/**
 * SessionStart Hook: TLDR Codebase Scan Storage
 *
 * On session startup/resume, runs tldr structure and tldr arch commands
 * and stores results in codebase_scans table for semantic retrieval.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

// Validate session ID format (alphanumeric, underscore, hyphen, max 128 chars)
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function validateSessionId(sessionId) {
  return SESSION_ID_PATTERN.test(sessionId);
}

// Max content size: 10MB
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

function validateContent(content) {
  if (!content || !content.trim()) {
    return { valid: false, error: 'Content is empty' };
  }
  if (content.length > MAX_CONTENT_SIZE) {
    return { valid: false, error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE})` };
  }
  return { valid: true };
}

function readStdin() {
  return readFileSync(0, 'utf-8');
}

function runTldrCommand(args, cwd) {
  try {
    const result = spawnSync('tldr', args, {
      encoding: 'utf-8',
      cwd,
      timeout: 60000,
    });

    if (result.status === 0) {
      return { success: true, output: result.stdout };
    } else {
      return { success: false, output: result.stdout, error: result.stderr };
    }
  } catch (error) {
    return { success: false, output: '', error: String(error) };
  }
}

function extractProjectName(projectDir) {
  const dirName = dirname(projectDir);

  const gitResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
    cwd: projectDir,
  });

  if (gitResult.status === 0) {
    const remoteUrl = gitResult.stdout.trim();
    const match = remoteUrl.match(/[:/]([^/]+)\.git$/) || remoteUrl.match(/[:/]([^/]+)$/);
    if (match) {
      return match[1];
    }
  }

  return dirName.split('/').pop() || 'unknown-project';
}

function extractMetadata(tldrOutput) {
  try {
    const parsed = JSON.parse(tldrOutput);
    return {
      file_count: parsed.files?.length || 0,
      function_count: parsed.functions?.length || 0,
    };
  } catch {
    return {};
  }
}

async function storeScan(sessionId, project, scanType, content, metadata) {
  const opcDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'opc');

  if (!validateSessionId(sessionId)) {
    console.error('Invalid session ID format');
    return false;
  }

  const contentValidation = validateContent(content);
  if (!contentValidation.valid) {
    console.error(`Content validation failed: ${contentValidation.error}`);
    return false;
  }

  const metadataJson = JSON.stringify(metadata);

  const result = spawnSync('uv', [
    'run',
    'python',
    'scripts/core/store_codebase_scan.py',
    '--session-id', sessionId,
    '--scan-type', scanType,
    '--project', project,
    '--content', '-',
    '--metadata', metadataJson,
  ], {
    encoding: 'utf-8',
    cwd: opcDir,
    input: content,
    env: {
      ...process.env,
      PYTHONPATH: opcDir,
    },
    timeout: 30000,
  });

  return result.status === 0;
}

async function main() {
  const input = JSON.parse(readStdin());

  if (!['resume', 'clear', 'compact'].includes(input.source)) {
    console.log('{}');
    return;
  }

  if (process.env.CLAUDE_AGENT_ID) {
    console.log('{}');
    return;
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  const project = extractProjectName(projectDir);
  const sessionId = input.session_id;

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  📊 CODEBASE ANALYSIS                                        │');
  console.log('├─────────────────────────────────────────────────────────────┤');

  let storedCount = 0;

  console.log('│  Scanning structure...                                       │');
  const structureResult = runTldrCommand(['structure', projectDir, '--lang', 'typescript'], projectDir);

  if (structureResult.success && structureResult.output) {
    const metadata = extractMetadata(structureResult.output);
    const success = await storeScan(sessionId, project, 'structure', structureResult.output, metadata);

    if (success) {
      storedCount++;
      console.log('│    ✓ Structure stored                                        │');
    } else {
      console.log('│    ✗ Structure storage failed                                │');
    }
  } else {
    console.log('│    ✗ Structure scan failed (tldr may not be installed)      │');
  }

  console.log('│  Analyzing architecture...                                   │');
  const archResult = runTldrCommand(['arch', projectDir], projectDir);

  if (archResult.success && archResult.output) {
    const success = await storeScan(sessionId, project, 'arch', archResult.output, {});

    if (success) {
      storedCount++;
      console.log('│    ✓ Architecture stored                                     │');
    } else {
      console.log('│    ✗ Architecture storage failed                             │');
    }
  } else {
    console.log('│    ✗ Architecture scan failed                                │');
  }

  console.log('└─────────────────────────────────────────────────────────────┘');

  if (storedCount > 0) {
    console.log('');
    console.log(JSON.stringify({
      result: 'continue',
      message: `Codebase scan complete: ${storedCount} analyses stored`,
    }));
  } else {
    console.log('{}');
  }
}

main().catch((error) => {
  console.error('TLDR scan hook error:', error);
  console.log('{}');
});
