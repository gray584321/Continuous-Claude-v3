var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

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
function getSocketPath(projectDir) {
  const hash = crypto.createHash("md5").update(projectDir).digest("hex").substring(0, 8);
  return `/tmp/tldr-${hash}.sock`;
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
function queryDaemon(query, projectDir) {
  return new Promise((resolve, reject) => {
    if (isIndexing(projectDir)) {
      resolve({
        indexing: true,
        status: "indexing",
        message: "Daemon is still indexing, results may be incomplete"
      });
      return;
    }
    const connInfo = getConnectionInfo(projectDir);
    if (!isDaemonReachable(projectDir)) {
      if (!tryStartDaemon(projectDir)) {
        resolve({ status: "unavailable", error: "Daemon not running and could not start" });
        return;
      }
    }
    const client = new net.Socket();
    let data = "";
    let resolved = false;
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        resolve({ status: "error", error: "timeout" });
      }
    }, QUERY_TIMEOUT);
    if (connInfo.type === "tcp") {
      client.connect(connInfo.port, connInfo.host, () => {
        client.write(JSON.stringify(query) + "\n");
      });
    } else {
      client.connect(connInfo.path, () => {
        client.write(JSON.stringify(query) + "\n");
      });
    }
    client.on("data", (chunk) => {
      data += chunk.toString();
      if (data.includes("\n")) {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          client.end();
          try {
            resolve(JSON.parse(data.trim()));
          } catch {
            resolve({ status: "error", error: "Invalid JSON response from daemon" });
          }
        }
      }
    });
    client.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (err.message.includes("ECONNREFUSED") || err.message.includes("ENOENT")) {
          resolve({ status: "unavailable", error: "Daemon not running" });
        } else {
          resolve({ status: "error", error: err.message });
        }
      }
    });
    client.on("close", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        if (data) {
          try {
            resolve(JSON.parse(data.trim()));
          } catch {
            resolve({ status: "error", error: "Incomplete response" });
          }
        } else {
          resolve({ status: "error", error: "Connection closed without response" });
        }
      }
    });
  });
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
async function pingDaemon(projectDir) {
  const response = await queryDaemon({ cmd: "ping" }, projectDir);
  return response.status === "ok";
}
async function searchDaemon(pattern, projectDir, maxResults = 100) {
  const response = await queryDaemon(
    { cmd: "search", pattern, max_results: maxResults },
    projectDir
  );
  return response.results || [];
}
async function impactDaemon(funcName, projectDir) {
  const response = await queryDaemon({ cmd: "impact", func: funcName }, projectDir);
  return response.callers || [];
}
async function extractDaemon(filePath, projectDir) {
  const response = await queryDaemon({ cmd: "extract", file: filePath }, projectDir);
  return response.result || null;
}
async function statusDaemon(projectDir) {
  return queryDaemon({ cmd: "status" }, projectDir);
}
async function deadCodeDaemon(projectDir, entryPoints, language = "python") {
  const response = await queryDaemon(
    { cmd: "dead", entry_points: entryPoints, language },
    projectDir
  );
  return response.result || response;
}
async function archDaemon(projectDir, language = "python") {
  const response = await queryDaemon({ cmd: "arch", language }, projectDir);
  return response.result || response;
}
async function cfgDaemon(filePath, funcName, projectDir, language = "python") {
  const response = await queryDaemon(
    { cmd: "cfg", file: filePath, function: funcName, language },
    projectDir
  );
  return response.result || response;
}
async function dfgDaemon(filePath, funcName, projectDir, language = "python") {
  const response = await queryDaemon(
    { cmd: "dfg", file: filePath, function: funcName, language },
    projectDir
  );
  return response.result || response;
}
async function sliceDaemon(filePath, funcName, line, projectDir, direction = "backward", variable) {
  const response = await queryDaemon(
    { cmd: "slice", file: filePath, function: funcName, line, direction, variable },
    projectDir
  );
  return response;
}
async function callsDaemon(projectDir, language = "python") {
  const response = await queryDaemon({ cmd: "calls", language }, projectDir);
  return response.result || response;
}
async function warmDaemon(projectDir, language = "python") {
  return queryDaemon({ cmd: "warm", language }, projectDir);
}
async function semanticSearchDaemon(projectDir, query, k = 10) {
  const response = await queryDaemon(
    { cmd: "semantic", action: "search", query, k },
    projectDir
  );
  return response.results || [];
}
async function semanticIndexDaemon(projectDir, language = "python") {
  return queryDaemon({ cmd: "semantic", action: "index", language }, projectDir);
}
async function treeDaemon(projectDir, extensions, excludeHidden = true) {
  const response = await queryDaemon(
    { cmd: "tree", extensions, exclude_hidden: excludeHidden },
    projectDir
  );
  return response.result || response;
}
async function structureDaemon(projectDir, language = "python", maxResults = 100) {
  const response = await queryDaemon(
    { cmd: "structure", language, max_results: maxResults },
    projectDir
  );
  return response.result || response;
}
async function contextDaemon(projectDir, entry, language = "python", depth = 2) {
  const response = await queryDaemon(
    { cmd: "context", entry, language, depth },
    projectDir
  );
  return response.result || response;
}
async function importsDaemon(projectDir, filePath, language = "python") {
  const response = await queryDaemon(
    { cmd: "imports", file: filePath, language },
    projectDir
  );
  return response.imports || [];
}
async function importersDaemon(projectDir, module, language = "python") {
  return queryDaemon({ cmd: "importers", module, language }, projectDir);
}
export {
  archDaemon,
  callsDaemon,
  cfgDaemon,
  contextDaemon,
  deadCodeDaemon,
  dfgDaemon,
  extractDaemon,
  getConnectionInfo,
  getSocketPath,
  getStatusFile,
  impactDaemon,
  importersDaemon,
  importsDaemon,
  isIndexing,
  pingDaemon,
  queryDaemon,
  queryDaemonSync,
  searchDaemon,
  semanticIndexDaemon,
  semanticSearchDaemon,
  sliceDaemon,
  statusDaemon,
  structureDaemon,
  treeDaemon,
  tryStartDaemon,
  warmDaemon
};
