/**
 * User Confirm Learning Hook
 *
 * Detects positive user confirmations (thanks, works, good, perfect)
 * and automatically extracts learnings for storage.
 */

import { existsSync, readFileSync } from 'fs';

interface UserPromptSubmitInput {
  session_id: string;
  user_prompt: string;
}

interface HookOutput {
  result: "continue";
  message?: string;
  learning?: {
    what: string;
    why: string;
    how: string;
    outcome: string;
    tags: string[];
  };
}

const STATE_FILE = '/tmp/claude-auto-learning-state.json';
const MAX_PROMPT_LENGTH = 100; // Short prompts only (confirmations are brief)
const MIN_CONTEXT_LENGTH = 20;

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
  });
}

function readStateFile(): { edits: Array<{ file: string; description: string; timestamp: number }> } | null {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
    }
  } catch {
    // Ignore read errors
  }
  return null;
}

function extractRecentContext(
  state: { edits: Array<{ file: string; description: string; timestamp: number }> } | null
): string {
  if (!state || !state.edits || state.edits.length === 0) {
    return '';
  }

  const now = Date.now();
  const RECENCY_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

  const recentEdits = state.edits.filter(
    e => (now - e.timestamp) < RECENCY_THRESHOLD_MS
  );

  if (recentEdits.length === 0) {
    return '';
  }

  return recentEdits
    .map(e => `${e.file}: ${e.description}`)
    .join('; ');
}

function isConfirmation(prompt: string): boolean {
  // Only short prompts are confirmations (not long task descriptions)
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return false;
  }

  // Detect positive confirmation patterns
  const confirmPatterns = [
    /^(works?|working|worked)!*$/i,
    /^(good|great|perfect|nice|excellent|awesome)!*$/i,
    /^(thanks?|thank you|thx|ty)!*$/i,
    /^(lgtm|ship it)!*$/i,
    /^(yes|yep|yeah)!*$/i,
    /\b(works?|working)\b/i,
    /\b(good|great|perfect|nice)\b/i,
    /\b(thanks?|thank you)\b/i,
    /\bthat('s| is) (it|right|correct)\b/i,
  ];

  return confirmPatterns.some(p => p.test(prompt));
}

async function main() {
  const input: UserPromptSubmitInput = JSON.parse(await readStdin());

  // Check if this is a confirmation
  if (!isConfirmation(input.user_prompt)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }

  // Get recent context from state file
  const state = readStateFile();
  const recentContext = extractRecentContext(state);

  // Need some context to create meaningful learning
  if (!recentContext || recentContext.length < MIN_CONTEXT_LENGTH) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }

  // Build the learning object
  const learning = {
    what: `User confirmed: "${input.user_prompt.slice(0, 50)}"`,
    why: 'Approach/solution worked for user',
    how: recentContext.slice(0, 300),
    outcome: 'success' as const,
    tags: ['user_confirmed', 'solution', 'auto_extracted']
  };

  const output: HookOutput = {
    result: "continue",
    message: `Learning confirmed: ${learning.what}`,
    learning
  };

  console.log(JSON.stringify(output));
}

main().catch((error) => {
  console.error(error);
  console.log(JSON.stringify({ result: "continue" }));
});
