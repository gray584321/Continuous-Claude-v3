// src/shared/learning-extractor.ts
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

// src/shared/learning-extractor.ts
async function storeLearning(learning, sessionId, projectDir) {
  const opcDir = getOpcDir();
  if (!opcDir) return false;
  const args = [
    "run",
    "python",
    "scripts/core/store_learning.py",
    "--session-id",
    sessionId
  ];
  if (learning.outcome === "success") {
    args.push("--worked", `${learning.what}. ${learning.how}`);
  } else if (learning.outcome === "failure") {
    args.push("--failed", `${learning.what}. ${learning.why}`);
  } else {
    args.push("--patterns", `${learning.what}: ${learning.how}`);
  }
  if (learning.why && learning.outcome !== "failure") {
    args.push("--decisions", learning.why);
  }
  const result = spawnSync("uv", args, {
    encoding: "utf-8",
    cwd: opcDir,
    env: {
      ...process.env,
      PYTHONPATH: opcDir
    },
    timeout: 1e4
  });
  return result.status === 0;
}
function extractTestPassLearning(event, recentEdits) {
  if (!event.tool_response) return null;
  const output = String(event.tool_response.output || "");
  const passPatterns = [
    /(\d+) passed/i,
    /tests? passed/i,
    /ok \(/i,
    /success/i,
    /\u2713/
    // checkmark
  ];
  const isPass = passPatterns.some((p) => p.test(output));
  if (!isPass) return null;
  const editSummary = recentEdits.map((e) => `${e.file}: ${e.description}`).join("; ");
  return {
    what: `Tests passed after: ${editSummary || "recent changes"}`,
    why: "Changes addressed the failing tests",
    how: recentEdits.length > 0 ? `Files modified: ${recentEdits.map((e) => e.file).join(", ")}` : "See recent edit history",
    outcome: "success",
    tags: ["test_pass", "fix", "auto_extracted"],
    context: output.slice(0, 200)
  };
}
function extractConfirmationLearning(prompt, recentContext) {
  const confirmPatterns = [
    /\b(works?|working)\b/i,
    /\b(good|great|perfect|nice)\b/i,
    /\b(thanks?|thank you)\b/i,
    /\b(yes|yep|yeah)\b/i,
    /\bthat('s| is) (it|right|correct)\b/i
  ];
  const isConfirmation = confirmPatterns.some((p) => p.test(prompt));
  if (!isConfirmation) return null;
  if (!recentContext || recentContext.length < 20) return null;
  return {
    what: `User confirmed: "${prompt.slice(0, 50)}"`,
    why: "Approach/solution worked for user",
    how: recentContext.slice(0, 300),
    outcome: "success",
    tags: ["user_confirmed", "solution", "auto_extracted"]
  };
}
function extractPeriodicLearning(turnCount, recentActions, sessionGoal) {
  return {
    what: `Turn ${turnCount} checkpoint: ${recentActions.length} actions`,
    why: sessionGoal || "Session progress tracking",
    how: recentActions.join("; ").slice(0, 500),
    outcome: "partial",
    tags: ["periodic", "progress", "procedural", "auto_extracted"]
  };
}
function extractAgentLearning(agentType, agentPrompt, agentResult) {
  return {
    what: `Agent ${agentType} completed task`,
    why: agentPrompt.slice(0, 200),
    how: `Result: ${agentResult.slice(0, 300)}`,
    outcome: agentResult.toLowerCase().includes("error") ? "failure" : "success",
    tags: ["agent", agentType, "auto_extracted"],
    context: agentPrompt
  };
}
export {
  extractAgentLearning,
  extractConfirmationLearning,
  extractPeriodicLearning,
  extractTestPassLearning,
  storeLearning
};
