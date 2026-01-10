var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/impact-refactor.ts
import { readFileSync as readFileSync2 } from "fs";

// src/daemon-client.ts
import { existsSync, readFileSync } from "fs";
import { execSync, spawnSync } from "child_process";
import { join } from "path";
import * as net from "net";
import * as crypto from "crypto";
var QUERY_TIMEOUT = 3e3;
function getConnectionInfo(projectDir) {
  const hash = crypto.createHash("md5").update(projectDir).digest("hex").substring(0, 8);
  if (process.platform === "win32") {
    const port = 49152 + parseInt(hash, 16) % 1e4;
    return { type: "tcp", host: "127.0.0.1", port };
  } else {
    return { type: "unix", path: `/tmp/tldr-${hash}.sock` };
  }
}
function getStatusFile(projectDir) {
  const statusPath = join(projectDir, ".tldr", "status");
  if (existsSync(statusPath)) {
    try {
      return readFileSync(statusPath, "utf-8").trim();
    } catch {
      return null;
    }
  }
  return null;
}
function isIndexing(projectDir) {
  return getStatusFile(projectDir) === "indexing";
}
function isDaemonReachable(projectDir) {
  const connInfo = getConnectionInfo(projectDir);
  if (connInfo.type === "tcp") {
    try {
      const testSocket = new net.Socket();
      testSocket.setTimeout(100);
      let connected = false;
      testSocket.on("connect", () => {
        connected = true;
        testSocket.destroy();
      });
      testSocket.on("error", () => {
        testSocket.destroy();
      });
      testSocket.connect(connInfo.port, connInfo.host);
      const end = Date.now() + 200;
      while (Date.now() < end && !connected) {
      }
      return connected;
    } catch {
      return false;
    }
  } else {
    if (!existsSync(connInfo.path)) {
      return false;
    }
    try {
      execSync(`echo '{"cmd":"ping"}' | nc -U "${connInfo.path}"`, {
        encoding: "utf-8",
        timeout: 500,
        stdio: ["pipe", "pipe", "pipe"]
      });
      return true;
    } catch {
      try {
        const { unlinkSync } = __require("fs");
        unlinkSync(connInfo.path);
      } catch {
      }
      return false;
    }
  }
}
function tryStartDaemon(projectDir) {
  try {
    if (isDaemonReachable(projectDir)) {
      return true;
    }
    const tldrPath = join(projectDir, "opc", "packages", "tldr-code");
    const result = spawnSync("uv", ["run", "tldr", "daemon", "start", "--project", projectDir], {
      timeout: 1e4,
      stdio: "ignore",
      cwd: tldrPath
    });
    if (result.status !== 0) {
      spawnSync("tldr", ["daemon", "start", "--project", projectDir], {
        timeout: 5e3,
        stdio: "ignore"
      });
    }
    const start = Date.now();
    while (Date.now() - start < 2e3) {
      if (isDaemonReachable(projectDir)) {
        return true;
      }
      const end = Date.now() + 50;
      while (Date.now() < end) {
      }
    }
    return isDaemonReachable(projectDir);
  } catch {
    return false;
  }
}
function queryDaemonSync(query, projectDir) {
  if (isIndexing(projectDir)) {
    return {
      indexing: true,
      status: "indexing",
      message: "Daemon is still indexing, results may be incomplete"
    };
  }
  const connInfo = getConnectionInfo(projectDir);
  if (!isDaemonReachable(projectDir)) {
    if (!tryStartDaemon(projectDir)) {
      return { status: "unavailable", error: "Daemon not running and could not start" };
    }
  }
  try {
    const input = JSON.stringify(query);
    let result;
    if (connInfo.type === "tcp") {
      const psCommand = `
        $client = New-Object System.Net.Sockets.TcpClient('${connInfo.host}', ${connInfo.port})
        $stream = $client.GetStream()
        $writer = New-Object System.IO.StreamWriter($stream)
        $reader = New-Object System.IO.StreamReader($stream)
        $writer.WriteLine('${input.replace(/'/g, "''")}')
        $writer.Flush()
        $response = $reader.ReadLine()
        $client.Close()
        Write-Output $response
      `.trim();
      result = execSync(`powershell -Command "${psCommand.replace(/"/g, '\\"')}"`, {
        encoding: "utf-8",
        timeout: QUERY_TIMEOUT
      });
    } else {
      result = execSync(`echo '${input}' | nc -U "${connInfo.path}"`, {
        encoding: "utf-8",
        timeout: QUERY_TIMEOUT
      });
    }
    return JSON.parse(result.trim());
  } catch (err) {
    if (err.killed) {
      return { status: "error", error: "timeout" };
    }
    if (err.message?.includes("ECONNREFUSED") || err.message?.includes("ENOENT")) {
      return { status: "unavailable", error: "Daemon not running" };
    }
    return { status: "error", error: err.message || "Unknown error" };
  }
}

// src/impact-refactor.ts
var REFACTOR_KEYWORDS = [
  /\brefactor\b/i,
  /\brename\b/i,
  /\bchange\b.*\bfunction\b/i,
  /\bmodify\b.*\b(?:function|method|class)\b/i,
  /\bupdate\b.*\bsignature\b/i,
  /\bmove\b.*\bfunction\b/i,
  /\bdelete\b.*\b(?:function|method)\b/i,
  /\bremove\b.*\b(?:function|method)\b/i,
  /\bextract\b.*\b(?:function|method)\b/i,
  /\binline\b.*\b(?:function|method)\b/i
];
var FUNCTION_PATTERNS = [
  /(?:refactor|rename|change|modify|update|move|delete|remove)\s+(?:the\s+)?(?:function\s+)?[`"']?(\w+)[`"']?/gi,
  /[`"'](\w+)[`"']\s+(?:function|method)/gi,
  /(?:function|method|def|fn)\s+[`"']?(\w+)[`"']?/gi
];
var EXCLUDE_WORDS = /* @__PURE__ */ new Set([
  "the",
  "this",
  "that",
  "function",
  "method",
  "class",
  "file",
  "to",
  "from",
  "into",
  "a",
  "an",
  "and",
  "or",
  "for",
  "with"
]);
function readStdin() {
  return readFileSync2(0, "utf-8");
}
function shouldTrigger(prompt) {
  return REFACTOR_KEYWORDS.some((pattern) => pattern.test(prompt));
}
function extractFunctionNames(prompt) {
  const candidates = /* @__PURE__ */ new Set();
  for (const pattern of FUNCTION_PATTERNS) {
    let match2;
    pattern.lastIndex = 0;
    while ((match2 = pattern.exec(prompt)) !== null) {
      const name = match2[1];
      if (name && name.length > 2 && !EXCLUDE_WORDS.has(name.toLowerCase())) {
        candidates.add(name);
      }
    }
  }
  const identifierPattern = /\b([a-z][a-z0-9_]*[a-z0-9])\b/gi;
  let match;
  while ((match = identifierPattern.exec(prompt)) !== null) {
    const name = match[1];
    if (name.length > 4 && !EXCLUDE_WORDS.has(name.toLowerCase())) {
      if (name.includes("_") || /[a-z][A-Z]/.test(name)) {
        candidates.add(name);
      }
    }
  }
  return Array.from(candidates);
}
function getImportersFromDaemon(moduleName, projectDir) {
  try {
    const response = queryDaemonSync({ cmd: "importers", module: moduleName }, projectDir);
    if (response.indexing) {
      return null;
    }
    if (response.status === "unavailable" || response.status === "error") {
      return null;
    }
    if (response.importers && Array.isArray(response.importers)) {
      return response.importers;
    }
    return [];
  } catch {
    return null;
  }
}
function getImpactFromDaemon(functionName, projectDir) {
  try {
    const response = queryDaemonSync({ cmd: "impact", func: functionName }, projectDir);
    if (response.indexing) {
      return null;
    }
    if (response.status === "unavailable" || response.status === "error") {
      return null;
    }
    if (response.callers && Array.isArray(response.callers)) {
      return response.callers;
    }
    return [];
  } catch {
    return null;
  }
}
function formatCallers(callers) {
  if (callers.length === 0) {
    return "No callers found (function may be an entry point or unused)";
  }
  return callers.slice(0, 15).map((c) => {
    const loc = c.line ? `${c.file}:${c.line}` : c.file;
    return `  - ${c.function || "unknown"} in ${loc}`;
  }).join("\n") + (callers.length > 15 ? `
  ... and ${callers.length - 15} more` : "");
}
function formatImporters(importers) {
  if (importers.length === 0) {
    return "No importers found";
  }
  return importers.slice(0, 10).map((i) => {
    const loc = i.line ? `${i.file}:${i.line}` : i.file;
    return `  - ${loc}`;
  }).join("\n") + (importers.length > 10 ? `
  ... and ${importers.length - 10} more` : "");
}
async function main() {
  const input = JSON.parse(readStdin());
  const prompt = input.prompt;
  if (!shouldTrigger(prompt)) {
    console.log("");
    return;
  }
  const functions = extractFunctionNames(prompt);
  if (functions.length === 0) {
    console.log("");
    return;
  }
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  const results = [];
  for (const funcName of functions.slice(0, 3)) {
    const callers = getImpactFromDaemon(funcName, projectDir);
    if (callers === null) {
      continue;
    }
    const importers = getImportersFromDaemon(funcName, projectDir);
    let impact = `\u{1F4CA} **Impact: ${funcName}**
Callers:
${formatCallers(callers)}`;
    if (importers && importers.length > 0) {
      impact += `

Module importers:
${formatImporters(importers)}`;
    }
    results.push(impact);
  }
  if (results.length > 0) {
    console.log(`
\u26A0\uFE0F **REFACTORING IMPACT ANALYSIS**

${results.join("\n\n")}

Consider callers AND importers before making changes.
`);
  } else {
    console.log("");
  }
}
main().catch(() => {
  console.log("");
});
