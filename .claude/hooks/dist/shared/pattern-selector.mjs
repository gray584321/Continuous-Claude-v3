// src/shared/python-bridge.ts
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
var __filename = fileURLToPath(import.meta.url);
var __dirname = dirname(__filename);
var PROJECT_DIR = process.env.CLAUDE_PROJECT_DIR || resolve(__dirname, "..", "..", "..", "..");
function callValidateComposition(patternA, patternB, scope, operator = ";") {
  const expr = `${patternA} ${operator}[${scope}] ${patternB}`;
  const cmd = `uv run python scripts/validate_composition.py --json "${expr}"`;
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 1e4,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const result = JSON.parse(stdout);
    return {
      valid: result.all_valid ?? false,
      composition: result.expression ?? expr,
      errors: result.compositions?.[0]?.errors ?? [],
      warnings: result.compositions?.[0]?.warnings ?? [],
      scopeTrace: result.compositions?.[0]?.scope_trace ?? []
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      valid: false,
      composition: expr,
      errors: [`Bridge error: ${errorMessage}`],
      warnings: [],
      scopeTrace: []
    };
  }
}
function callPatternInference(prompt) {
  const escaped = prompt.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const cmd = `uv run python scripts/agentica_patterns/pattern_inference.py "${escaped}"`;
  try {
    const stdout = execSync(cmd, {
      cwd: PROJECT_DIR,
      encoding: "utf-8",
      timeout: 1e4,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const result = JSON.parse(stdout);
    return {
      pattern: result.pattern,
      confidence: result.confidence ?? 0.5,
      signals: result.signals ?? [],
      needsClarification: result.needs_clarification ?? false,
      clarificationProbe: result.clarification_probe ?? null,
      ambiguityType: result.ambiguity_type ?? null,
      alternatives: result.alternatives ?? [],
      workBreakdown: result.work_breakdown ?? "Task decomposition"
    };
  } catch (err) {
    return {
      pattern: "hierarchical",
      confidence: 0.3,
      signals: ["bridge error fallback"],
      needsClarification: true,
      clarificationProbe: "Could not infer pattern - what would help?",
      ambiguityType: "scope",
      alternatives: [],
      workBreakdown: "Coordinated task decomposition with specialists"
    };
  }
}

// src/shared/pattern-selector.ts
var SUPPORTED_PATTERNS = [
  "swarm",
  "jury",
  "pipeline",
  "generator_critic",
  "hierarchical",
  "map_reduce",
  "blackboard",
  "circuit_breaker",
  "chain_of_responsibility",
  "adversarial",
  "event_driven",
  "consensus",
  "aggregator",
  "broadcast"
];
function selectPattern(task) {
  const result = callPatternInference(task.description);
  return {
    pattern: result.pattern,
    confidence: result.confidence,
    reason: result.workBreakdown
  };
}
function validateComposition(patterns, scope = "handoff", operator = ";") {
  if (patterns.length === 0) {
    return {
      valid: true,
      composition: "",
      errors: [],
      warnings: [],
      scopeTrace: []
    };
  }
  if (patterns.length === 1) {
    return {
      valid: true,
      composition: patterns[0],
      errors: [],
      warnings: [],
      scopeTrace: []
    };
  }
  const allWarnings = [];
  const allTraces = [];
  let compositionStr = patterns[0];
  for (let i = 0; i < patterns.length - 1; i++) {
    const result = callValidateComposition(
      patterns[i],
      patterns[i + 1],
      scope,
      operator
    );
    if (!result.valid) {
      return {
        valid: false,
        composition: compositionStr,
        errors: result.errors,
        warnings: result.warnings,
        scopeTrace: result.scopeTrace
      };
    }
    allWarnings.push(...result.warnings);
    allTraces.push(...result.scopeTrace);
    compositionStr = result.composition;
  }
  return {
    valid: true,
    composition: compositionStr,
    errors: [],
    warnings: allWarnings,
    scopeTrace: allTraces
  };
}
export {
  SUPPORTED_PATTERNS,
  selectPattern,
  validateComposition
};
