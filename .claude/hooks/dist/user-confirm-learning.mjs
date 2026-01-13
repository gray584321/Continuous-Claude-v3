// src/user-confirm-learning.ts
import { existsSync, readFileSync } from "fs";
var STATE_FILE = "/tmp/claude-auto-learning-state.json";
var MAX_PROMPT_LENGTH = 100;
var MIN_CONTEXT_LENGTH = 20;
function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => data += chunk);
    process.stdin.on("end", () => resolve(data));
  });
}
function readStateFile() {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {
  }
  return null;
}
function extractRecentContext(state) {
  if (!state || !state.edits || state.edits.length === 0) {
    return "";
  }
  const now = Date.now();
  const RECENCY_THRESHOLD_MS = 10 * 60 * 1e3;
  const recentEdits = state.edits.filter(
    (e) => now - e.timestamp < RECENCY_THRESHOLD_MS
  );
  if (recentEdits.length === 0) {
    return "";
  }
  return recentEdits.map((e) => `${e.file}: ${e.description}`).join("; ");
}
function isConfirmation(prompt) {
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return false;
  }
  const confirmPatterns = [
    /^(works?|working|worked)!*$/i,
    /^(good|great|perfect|nice|excellent|awesome)!*$/i,
    /^(thanks?|thank you|thx|ty)!*$/i,
    /^(lgtm|ship it)!*$/i,
    /^(yes|yep|yeah)!*$/i,
    /\b(works?|working)\b/i,
    /\b(good|great|perfect|nice)\b/i,
    /\b(thanks?|thank you)\b/i,
    /\bthat('s| is) (it|right|correct)\b/i
  ];
  return confirmPatterns.some((p) => p.test(prompt));
}
async function main() {
  const input = JSON.parse(await readStdin());
  if (!isConfirmation(input.user_prompt)) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const state = readStateFile();
  const recentContext = extractRecentContext(state);
  if (!recentContext || recentContext.length < MIN_CONTEXT_LENGTH) {
    console.log(JSON.stringify({ result: "continue" }));
    return;
  }
  const learning = {
    what: `User confirmed: "${input.user_prompt.slice(0, 50)}"`,
    why: "Approach/solution worked for user",
    how: recentContext.slice(0, 300),
    outcome: "success",
    tags: ["user_confirmed", "solution", "auto_extracted"]
  };
  const output = {
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
