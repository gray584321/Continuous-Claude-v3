// src/shared/project-state.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
var PROJECT_STATE_VERSION = "1.0";
function getProjectStatePath(projectDir) {
  return join(projectDir, ".claude", "cache", "project-state.json");
}
function loadProjectState(projectDir) {
  const path = getProjectStatePath(projectDir);
  if (existsSync(path)) {
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
    }
  }
  return {
    version: PROJECT_STATE_VERSION,
    activePlan: null,
    activeSpec: null,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
function saveProjectState(projectDir, state) {
  const path = getProjectStatePath(projectDir);
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
  writeFileSync(path, JSON.stringify(state, null, 2));
}
function setActivePlan(projectDir, planPath) {
  const state = loadProjectState(projectDir);
  state.activePlan = planPath;
  saveProjectState(projectDir, state);
}
function setActiveSpec(projectDir, specPath) {
  const state = loadProjectState(projectDir);
  state.activeSpec = specPath;
  saveProjectState(projectDir, state);
}
function findLatestFile(dir, pattern = /\.md$/) {
  if (!existsSync(dir)) return null;
  try {
    const files = readdirSync(dir).filter((f) => pattern.test(f)).map((f) => {
      const fullPath = join(dir, f);
      const stat = statSync(fullPath);
      const dateMatch = f.match(/^(\d{4}-\d{2}-\d{2})/);
      const fileDate = dateMatch ? new Date(dateMatch[1]).getTime() : stat.mtimeMs;
      return { path: fullPath, date: fileDate };
    }).sort((a, b) => b.date - a.date);
    return files.length > 0 ? files[0].path : null;
  } catch {
    return null;
  }
}
function getActivePlanOrLatest(projectDir) {
  const state = loadProjectState(projectDir);
  if (state.activePlan && existsSync(state.activePlan)) {
    return state.activePlan;
  }
  const planDirs = [
    join(projectDir, "thoughts", "shared", "plans"),
    join(projectDir, "plans"),
    join(projectDir, "specs")
  ];
  for (const dir of planDirs) {
    const latest = findLatestFile(dir);
    if (latest) return latest;
  }
  return null;
}
function getActiveSpecOrLatest(projectDir) {
  const state = loadProjectState(projectDir);
  if (state.activeSpec && existsSync(state.activeSpec)) {
    return state.activeSpec;
  }
  const specDirs = [
    join(projectDir, "thoughts", "shared", "specs"),
    join(projectDir, "specs")
  ];
  for (const dir of specDirs) {
    const latest = findLatestFile(dir);
    if (latest) return latest;
  }
  return null;
}
export {
  findLatestFile,
  getActivePlanOrLatest,
  getActiveSpecOrLatest,
  getProjectStatePath,
  loadProjectState,
  saveProjectState,
  setActivePlan,
  setActiveSpec
};
