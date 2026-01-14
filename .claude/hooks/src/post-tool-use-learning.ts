/**
 * Post-Tool-Use Learning Hook
 *
 * Automatically extracts learnings from tool results and stores them.
 * Tracks successful patterns, failed attempts, and working solutions.
 */

import { readFileSync, existsSync } from 'fs';
import { storeLearning, extractTestPassLearning, extractEditLearning, LearningEvent } from './shared/learning-extractor.js';
import { getLearningState } from './shared/auto-learning-state.js';

interface HookInput {
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_result?: {
    success?: boolean;
    output?: string;
    error?: string;
  };
  session_id: string;
  timestamp: string;
}

interface HookOutput {
  learning?: {
    what: string;
    why: string;
    how: string;
    outcome: 'success' | 'failure' | 'partial';
    tags: string[];
    context?: string;
  };
}

function readStdin(): string {
  try {
    return readFileSync(0, 'utf-8');
  } catch {
    return '{}';
  }
}

async function main() {
  const input: HookInput = JSON.parse(readStdin());
  const { tool_name, tool_input, tool_result, session_id } = input;
  
  if (!session_id) {
    console.log('{}');
    return;
  }

  // Get project directory
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  
  // Get learning state for tracking recent edits
  const learningState = getLearningState();
  
  let learning: LearningEvent | null = null;
  
  // Extract learnings based on tool type
  switch (tool_name) {
    case 'Edit':
    case 'Write':
      learning = extractEditLearning(
        { 
          type: 'edit',
          tool_name,
          tool_input,
          tool_result,
          session_id
        },
        learningState.recentEdits
      );
      break;
      
    case 'Bash':
      // Check if it's a test command
      const command = (tool_input?.command as string) || '';
      if (command.match(/\b(test|pytest|jest|npm test|yarn test)\b/)) {
        learning = extractTestPassLearning(
          {
            type: 'test_pass',
            tool_name,
            tool_input,
            tool_result,
            session_id
          },
          learningState.recentEdits.map(e => ({ file: e.file, description: e.type }))
        );
      }
      break;
      
    case 'Read':
    case 'Grep':
    case 'Glob':
      // Learning: Found what we were looking for
      if (tool_result?.success && tool_result?.output) {
        learning = {
          type: 'edit', // Use edit type for consistency
          tool_name,
          tool_input,
          tool_result,
          session_id,
          outcome: 'success',
          what: `Successfully found information using ${tool_name}`,
          why: `Search/query was successful`,
          how: `Used ${tool_name} with appropriate parameters`,
          tags: ['search', 'discovery']
        };
      }
      break;
  }
  
  // Store learning if we found one
  if (learning) {
    try {
      const success = await storeLearning(
        {
          what: learning.what,
          why: learning.why,
          how: learning.how,
          outcome: learning.outcome,
          tags: learning.tags,
          context: learning.context
        },
        session_id,
        projectDir
      );
      
      if (success) {
        console.log(JSON.stringify({
          learning: {
            what: learning.what,
            why: learning.why,
            how: learning.how,
            outcome: learning.outcome,
            tags: learning.tags,
            context: learning.context
          }
        }));
        return;
      }
    } catch (err) {
      console.error(`[post-tool-use-learning] Error storing learning: ${err}`);
    }
  }
  
  console.log('{}');
}

main().catch(err => {
  console.error(`[post-tool-use-learning] Fatal error: ${err}`);
  console.log('{}');
});
