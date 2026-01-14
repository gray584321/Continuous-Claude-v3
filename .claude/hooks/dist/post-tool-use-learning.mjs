// src/post-tool-use-learning.ts
import { readFileSync } from "fs";

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
function extractEditLearning(event, recentEdits) {
  if (!event.tool_input || !event.tool_result) return null;
  const filePath = event.tool_input.file_path;
  if (!filePath) return null;
  const isSuccess = event.tool_result.success !== false;
  const outcome = isSuccess ? "success" : "failure";
  let description = `Edited ${filePath}`;
  if (event.tool_input.replacement_string) {
    const replacement = event.tool_input.replacement_string;
    if (replacement.length < 100) {
      description = `Modified ${filePath}: "${replacement.slice(0, 50)}..."`;
    }
  }
  return {
    what: description,
    why: isSuccess ? "Edit was successful" : "Edit failed or was cancelled",
    how: `Used ${event.tool_name} tool on ${filePath}`,
    outcome,
    tags: ["edit", outcome, "auto_extracted"],
    context: filePath
  };
}

// src/shared/auto-learning-state.ts
function createLearningState() {
  const recentEdits = [];
  const MAX_EDITS = 10;
  function addEdit(file, type) {
    const entry = {
      file,
      type,
      timestamp: Date.now()
    };
    recentEdits.push(entry);
    while (recentEdits.length > MAX_EDITS) {
      recentEdits.shift();
    }
  }
  function isDuplicate(file, windowMs = 3e4) {
    const now = Date.now();
    return recentEdits.some(
      (entry) => entry.file === file && now - entry.timestamp < windowMs
    );
  }
  function cleanup() {
    recentEdits.length = 0;
  }
  return {
    get recentEdits() {
      return [...recentEdits];
    },
    addEdit,
    isDuplicate,
    cleanup
  };
}
var instance = null;
function getLearningState() {
  if (!instance) {
    instance = createLearningState();
  }
  return instance;
}

// src/post-tool-use-learning.ts
function readStdin() {
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "{}";
  }
}
async function main() {
  const input = JSON.parse(readStdin());
  const { tool_name, tool_input, tool_result, session_id } = input;
  if (!session_id) {
    console.log("{}");
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const learningState = getLearningState();
  let learning = null;
  switch (tool_name) {
    case "Edit":
    case "Write":
      learning = extractEditLearning(
        {
          type: "edit",
          tool_name,
          tool_input,
          tool_result,
          session_id
        },
        learningState.recentEdits
      );
      break;
    case "Bash":
      const command = tool_input?.command || "";
      if (command.match(/\b(test|pytest|jest|npm test|yarn test)\b/)) {
        learning = extractTestPassLearning(
          {
            type: "test_pass",
            tool_name,
            tool_input,
            tool_result,
            session_id
          },
          learningState.recentEdits.map((e) => ({ file: e.file, description: e.type }))
        );
      }
      break;
    case "Read":
    case "Grep":
    case "Glob":
      if (tool_result?.success && tool_result?.output) {
        learning = {
          type: "edit",
          // Use edit type for consistency
          tool_name,
          tool_input,
          tool_result,
          session_id,
          outcome: "success",
          what: `Successfully found information using ${tool_name}`,
          why: `Search/query was successful`,
          how: `Used ${tool_name} with appropriate parameters`,
          tags: ["search", "discovery"]
        };
      }
      break;
  }
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
  console.log("{}");
}
main().catch((err) => {
  console.error(`[post-tool-use-learning] Fatal error: ${err}`);
  console.log("{}");
});
