/**
 * SessionStart Hook: TLDR Codebase Scan Storage
 *
 * On session startup/resume, runs tldr structure and tldr arch commands
 * and stores results in codebase_scans table for semantic retrieval.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';

interface SessionStartInput {
  session_id: string;
  hook_event_name: string;
  source: 'startup' | 'resume' | 'clear' | 'compact';
  cwd: string;
}

interface TldrResult {
  success: boolean;
  output: string;
  error?: string;
}

// Validate session ID format (alphanumeric, underscore, hyphen, max 128 chars)
const SESSION_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function validateSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

// Max content size: 10MB
const MAX_CONTENT_SIZE = 10 * 1024 * 1024;

function validateContent(content: string): { valid: boolean; error?: string } {
  if (!content || !content.trim()) {
    return { valid: false, error: 'Content is empty' };
  }
  if (content.length > MAX_CONTENT_SIZE) {
    return { valid: false, error: `Content too large: ${content.length} bytes (max: ${MAX_CONTENT_SIZE})` };
  }
  return { valid: true };
}

function readStdin(): string {
  return readFileSync(0, 'utf-8');
}

function runTldrCommand(args: string[], cwd: string): TldrResult {
  try {
    const result = spawnSync('tldr', args, {
      encoding: 'utf-8',
      cwd,
      timeout: 60000,  // 60 second timeout for tldr commands
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

function extractProjectName(projectDir: string): string {
  // Try to extract project name from git remote or directory
  const dirName = dirname(projectDir);

  // Try git remote first
  const gitResult = spawnSync('git', ['remote', 'get-url', 'origin'], {
    encoding: 'utf-8',
    cwd: projectDir,
  });

  if (gitResult.status === 0) {
    const remoteUrl = gitResult.stdout.trim();
    // Extract project name from URL
    const match = remoteUrl.match(/[:/]([^/]+)\.git$/) || remoteUrl.match(/[:/]([^/]+)$/);
    if (match) {
      return match[1];
    }
  }

  // Fallback to directory name
  return dirName.split('/').pop() || 'unknown-project';
}

function extractMetadata(tldrOutput: string): Record<string, unknown> {
  // Try to extract file/function counts from tldr structure output
  try {
    const parsed = JSON.parse(tldrOutput);
    return {
      file_count: parsed.files?.length || 0,
      function_count: parsed.functions?.length || 0,
    };
  } catch {
    // Not JSON or parsing failed
    return {};
  }
}

async function storeScan(
  sessionId: string,
  project: string,
  scanType: string,
  content: string,
  metadata: Record<string, unknown>
): Promise<boolean> {
  const opcDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'opc');

  // Validate session ID
  if (!validateSessionId(sessionId)) {
    console.error('Invalid session ID format');
    return false;
  }

  // Validate content size
  const contentValidation = validateContent(content);
  if (!contentValidation.valid) {
    console.error(`Content validation failed: ${contentValidation.error}`);
    return false;
  }

  // Build metadata JSON string
  const metadataJson = JSON.stringify(metadata);

  // Use stdin for content to avoid command injection
  const result = spawnSync('uv', [
    'run',
    'python',
    'scripts/core/store_codebase_scan.py',
    '--session-id', sessionId,
    '--scan-type', scanType,
    '--project', project,
    '--content', '-',  // Read from stdin
    '--metadata', metadataJson,
  ], {
    encoding: 'utf-8',
    cwd: opcDir,
    input: content,  // Pass content via stdin
    env: {
      ...process.env,
      PYTHONPATH: opcDir,
    },
    timeout: 30000,
  });

  return result.status === 0;
}

async function main() {
  const input: SessionStartInput = JSON.parse(readStdin());

  // Only run on resume, clear, or compact (not startup - full scan is expensive)
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
  const sessionId = input.session_id;

  console.log('');
  console.log('\u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510');
  console.log('\u2502  \u{1F4CA} CODEBASE ANALYSIS                               \u2502');

  let storedCount = 0;

  // Run tldr structure
  console.log('\u2502    Scanning structure...');
  const structureResult = runTldrCommand(['structure', projectDir, '--lang', 'typescript'], projectDir);

  if (structureResult.success && structureResult.output) {
    const metadata = extractMetadata(structureResult.output);
    const success = await storeScan(sessionId, project, 'structure', structureResult.output, metadata);

    if (success) {
      storedCount++;
      console.log('\u2502      \u2713 Structure stored');
    } else {
      console.log('\u2502      \u2717 Structure storage failed');
    }
  } else {
    console.log('\u2502      \u2717 Structure scan failed (tldr may not be installed)');
  }

  // Run tldr arch
  console.log('\u2502    Analyzing architecture...');
  const archResult = runTldrCommand(['arch', projectDir], projectDir);

  if (archResult.success && archResult.output) {
    const success = await storeScan(sessionId, project, 'arch', archResult.output, {});

    if (success) {
      storedCount++;
      console.log('\u2502      \u2713 Architecture stored');
    } else {
      console.log('\u2502      \u2717 Architecture storage failed');
    }
  } else {
    console.log('\u2502      \u2717 Architecture scan failed');
  }

  console.log('\u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518');

  if (storedCount > 0) {
    console.log('');
    console.log(JSON.stringify({
      result: 'continue',
      message: `Codebase scan complete: ${storedCount} analyses stored for semantic search`,
    }));
  } else {
    console.log('{}');
  }
}

main().catch((error) => {
  console.error('TLDR scan hook error:', error);
  console.log('{}');
});
