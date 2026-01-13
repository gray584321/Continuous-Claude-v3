// src/shared/spec-context.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from "fs";
import { join, dirname } from "path";
var SPEC_CONTEXT_VERSION = "1.0";
var CHECKPOINT_INTERVAL = 5;
function getSpecContextPath(projectDir) {
  return join(projectDir, ".claude", "cache", "spec-context.json");
}
function loadSpecContext(projectDir) {
  const path = getSpecContextPath(projectDir);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
    }
  }
  return { version: SPEC_CONTEXT_VERSION, sessions: {} };
}
function saveSpecContext(projectDir, context) {
  const path = getSpecContextPath(projectDir);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(context, null, 2));
}
function getSessionContext(projectDir, sessionId) {
  const context = loadSpecContext(projectDir);
  return context.sessions[sessionId] || null;
}
function createEmptySessionContext() {
  return {
    active_spec: null,
    current_phase: null,
    activated_at: (/* @__PURE__ */ new Date()).toISOString(),
    edit_count: 0,
    last_checkpoint: 0,
    agents: {}
  };
}
function setSessionSpec(projectDir, sessionId, specPath, phase) {
  const context = loadSpecContext(projectDir);
  const existing = context.sessions[sessionId] || createEmptySessionContext();
  context.sessions[sessionId] = {
    ...existing,
    active_spec: specPath,
    current_phase: phase || existing.current_phase,
    activated_at: (/* @__PURE__ */ new Date()).toISOString(),
    edit_count: 0,
    last_checkpoint: 0
  };
  saveSpecContext(projectDir, context);
}
function setSessionPhase(projectDir, sessionId, phase) {
  const context = loadSpecContext(projectDir);
  if (context.sessions[sessionId]) {
    context.sessions[sessionId].current_phase = phase;
    saveSpecContext(projectDir, context);
  }
}
function registerAgent(projectDir, sessionId, parentSessionId, scope) {
  const context = loadSpecContext(projectDir);
  const parentContext = parentSessionId ? context.sessions[parentSessionId] : null;
  context.sessions[sessionId] = {
    active_spec: parentContext?.active_spec || null,
    current_phase: scope.section,
    activated_at: (/* @__PURE__ */ new Date()).toISOString(),
    edit_count: 0,
    last_checkpoint: 0,
    agents: {}
  };
  if (parentSessionId && context.sessions[parentSessionId]) {
    context.sessions[parentSessionId].agents[sessionId] = {
      ...scope,
      registered_at: (/* @__PURE__ */ new Date()).toISOString(),
      parent_session: parentSessionId
    };
  }
  saveSpecContext(projectDir, context);
}
function unregisterAgent(projectDir, sessionId) {
  const context = loadSpecContext(projectDir);
  for (const [parentId, session] of Object.entries(context.sessions)) {
    if (session.agents[sessionId]) {
      delete session.agents[sessionId];
    }
  }
  delete context.sessions[sessionId];
  saveSpecContext(projectDir, context);
}
function incrementEditCount(projectDir, sessionId) {
  const context = loadSpecContext(projectDir);
  const session = context.sessions[sessionId];
  if (!session) {
    return { count: 0, needsCheckpoint: false };
  }
  session.edit_count++;
  const editsSinceCheckpoint = session.edit_count - session.last_checkpoint;
  const needsCheckpoint = editsSinceCheckpoint >= CHECKPOINT_INTERVAL;
  if (needsCheckpoint) {
    session.last_checkpoint = session.edit_count;
  }
  saveSpecContext(projectDir, context);
  return { count: session.edit_count, needsCheckpoint };
}
function clearSession(projectDir, sessionId) {
  const context = loadSpecContext(projectDir);
  delete context.sessions[sessionId];
  saveSpecContext(projectDir, context);
}
function findSpecFile(projectDir, specName) {
  const specDirs = [
    join(projectDir, "thoughts", "shared", "specs"),
    join(projectDir, "thoughts", "shared", "plans"),
    join(projectDir, "specs"),
    join(projectDir, "plans")
  ];
  for (const dir of specDirs) {
    if (!existsSync(dir)) continue;
    const files = readdirSync(dir);
    const exact = files.find((f) => f === specName || f === `${specName}.md`);
    if (exact) return join(dir, exact);
    const partial = files.find(
      (f) => f.toLowerCase().includes(specName.toLowerCase()) && f.endsWith(".md")
    );
    if (partial) return join(dir, partial);
  }
  if (specName.endsWith(".md") && existsSync(join(projectDir, specName))) {
    return join(projectDir, specName);
  }
  return null;
}
function extractSpecRequirements(specContent, section) {
  if (section) {
    const sectionRegex = new RegExp(`## ${section}[\\s\\S]*?(?=\\n## |$)`, "i");
    const match = specContent.match(sectionRegex);
    if (match) {
      return extractCriteria(match[0]);
    }
  }
  return extractCriteria(specContent);
}
function extractCriteria(content) {
  const sections = [
    "## Requirements",
    "## Functional Requirements",
    "## Must Have",
    "## Success Criteria",
    "## Acceptance Criteria",
    "### Success Criteria",
    "### Acceptance Criteria"
  ];
  const extracted = [];
  for (const section of sections) {
    const regex = new RegExp(`${section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?(?=\\n## |\\n### |$)`, "i");
    const match = content.match(regex);
    if (match) {
      extracted.push(match[0].slice(0, 600));
    }
  }
  const checkboxes = content.match(/- \[ \] .+/g) || [];
  if (checkboxes.length > 0) {
    extracted.push("Acceptance Criteria:\n" + checkboxes.slice(0, 10).join("\n"));
  }
  if (extracted.length > 0) {
    return extracted.join("\n\n").slice(0, 1500);
  }
  return content.slice(0, 800);
}
function extractAcceptanceCriteria(specContent, section) {
  const content = section ? extractSpecRequirements(specContent, section) : specContent;
  const criteria = [];
  const checkboxes = content.match(/- \[ \] .+/g) || [];
  criteria.push(...checkboxes);
  const numbered = content.match(/^\d+\.\s+.+$/gm) || [];
  criteria.push(...numbered);
  return [...new Set(criteria)].slice(0, 15);
}
export {
  clearSession,
  createEmptySessionContext,
  extractAcceptanceCriteria,
  extractSpecRequirements,
  findSpecFile,
  getSessionContext,
  getSpecContextPath,
  incrementEditCount,
  loadSpecContext,
  registerAgent,
  saveSpecContext,
  setSessionPhase,
  setSessionSpec,
  unregisterAgent
};
