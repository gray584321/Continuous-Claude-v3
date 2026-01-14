/**
 * SessionEnd Hook: Learning Extraction
 *
 * On session end, extracts key learnings from the session transcript
 * and stores them in archival_memory for future semantic retrieval.
 */

import { spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

function readStdin() {
  return readFileSync(0, 'utf-8');
}

function extractLearningsFromTranscript(transcriptPath) {
  const content = readFileSync(transcriptPath, 'utf-8');

  const learningPatterns = [
    {
      regex: /What\s+worked[:\s]+([^\n]+(?:\n(?!\s*What|Decisions|Pattern)[^\n]+)*)/gi,
      type: 'WORKING_SOLUTION',
      context: 'success'
    },
    {
      regex: /What\s+failed[:\s]+([^\n]+(?:\n(?!\s*What|Decisions|Pattern)[^\n]+)*)/gi,
      type: 'FAILED_APPROACH',
      context: 'failure'
    },
    {
      regex: /Decisions?[:\s]+([^\n]+(?:\n(?!\s*What|Decisions|Pattern)[^\n]+)*)/gi,
      type: 'ARCHITECTURAL_DECISION',
      context: 'decision'
    },
    {
      regex: /Pattern[s]?[:\s]+([^\n]+(?:\n(?!\s*What|Decisions|Pattern)[^\n]+)*)/gi,
      type: 'CODEBASE_PATTERN',
      context: 'pattern'
    },
    {
      regex: /Error[:\s]+([^\n]+(?:\n(?!\s*What|Decisions|Pattern|Error)[^\n]+)*)/gi,
      type: 'ERROR_FIX',
      context: 'error'
    },
  ];

  const learnings = [];

  for (const pattern of learningPatterns) {
    let match;
    while ((match = pattern.regex.exec(content)) !== null) {
      const extractedText = match[1].trim();

      if (extractedText.length < 20 || extractedText.includes('TODO') || extractedText.includes('FIXME')) {
        continue;
      }

      let confidence = 'medium';
      if (extractedText.length > 100) {
        confidence = 'high';
      } else if (extractedText.length < 50) {
        confidence = 'low';
      }

      learnings.push({
        type: pattern.type,
        content: extractedText,
        confidence,
        context: pattern.context
      });
    }
  }

  const uniqueLearnings = [];

  for (const learning of learnings) {
    const isDuplicate = uniqueLearnings.some(existing =>
      existing.type === learning.type &&
      existing.content.length > 50 &&
      similarity(existing.content, learning.content) > 0.85
    );

    if (!isDuplicate) {
      uniqueLearnings.push(learning);
    }
  }

  return uniqueLearnings.slice(0, 10);
}

function similarity(str1, str2) {
  const words1 = new Set(str1.toLowerCase().split(/\W+/).filter(w => w.length > 3));
  const words2 = new Set(str2.toLowerCase().split(/\W+/).filter(w => w.length > 3));

  const intersection = new Set([...words1].filter(x => words2.has(x)));
  const union = new Set([...words1, ...words2]);

  return intersection.size / union.size;
}

async function storeLearning(sessionId, learningType, content, confidence, context) {
  const opcDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), 'opc');

  const result = spawnSync('uv', [
    'run',
    'python',
    'scripts/core/store_learning.py',
    '--session-id', sessionId,
    '--type', learningType,
    '--content', content,
    '--context', context,
    '--confidence', confidence,
    '--json'
  ], {
    encoding: 'utf-8',
    cwd: opcDir,
    env: {
      ...process.env,
      PYTHONPATH: opcDir,
    },
    timeout: 30000,
  });

  if (result.status === 0) {
    try {
      const output = JSON.parse(result.stdout);
      return output.success === true;
    } catch {
      return false;
    }
  }

  return false;
}

async function main() {
  const input = JSON.parse(readStdin());

  if (!input.transcript_path || !existsSync(input.transcript_path)) {
    console.log('{}');
    return;
  }

  if (process.env.CLAUDE_AGENT_ID) {
    console.log('{}');
    return;
  }

  console.log('');
  console.log('┌─────────────────────────────────────────────────────────────┐');
  console.log('│  📚 EXTRACTING SESSION LEARNINGS                              │');
  console.log('├─────────────────────────────────────────────────────────────┤');

  try {
    const learnings = extractLearningsFromTranscript(input.transcript_path);

    if (learnings.length === 0) {
      console.log('│  No learnings detected                                        │');
      console.log('└─────────────────────────────────────────────────────────────┘');
      console.log('');
      console.log('{}');
      return;
    }

    console.log(`│  Found ${learnings.length} potential learnings                   │`);

    let storedCount = 0;
    let skippedCount = 0;

    for (const learning of learnings) {
      const success = await storeLearning(
        input.session_id,
        learning.type,
        learning.content,
        learning.confidence,
        learning.context
      );

      if (success) {
        storedCount++;
        console.log(`│  ✓ ${learning.type.padEnd(28)} | ${learning.confidence.padEnd(8)} │`);
      } else {
        skippedCount++;
        console.log(`│  ✗ ${learning.type.padEnd(28)} | skipped             │`);
      }
    }

    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');

    console.log(JSON.stringify({
      result: 'continue',
      message: `Session learnings: ${storedCount} stored, ${skippedCount} skipped`,
    }));

  } catch (error) {
    console.log('│  Error extracting learnings                                   │');
    console.log('└─────────────────────────────────────────────────────────────┘');
    console.log('');
    console.log('{}');
  }
}

main().catch((error) => {
  console.error('Learning extraction hook error:', error);
  console.log('{}');
});
