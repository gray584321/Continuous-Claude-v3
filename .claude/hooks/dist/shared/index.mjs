// src/shared/workflow-erotetic.ts
var IMPL_PATTERNS = /\b(build|implement|create|add|develop|design|set up|write)\b/i;
var NON_IMPL_PATTERNS = /\b(fix|run|show|explain|list|search|rename|delete|update)\b/i;
var PROPOSITION_PATTERNS = {
  framework: /\b(fastapi|express|hono|gin|django|flask|rails|spring|nest\.?js)\b/i,
  auth_method: /\b(jwt|oauth\d?|session|api[- ]?key|basic auth|bearer|saml|oidc)\b/i,
  database: /\b(postgres|postgresql|mysql|sqlite|mongodb|redis|dynamodb|firestore)\b/i,
  hosting: /\b(vercel|aws|gcp|azure|heroku|railway|fly\.io|cloudflare)\b/i,
  language: /\b(python|typescript|javascript|go|rust|java|ruby|php)\b/i,
  testing: /\b(pytest|jest|vitest|mocha|junit|rspec)\b/i
};
var CRITICAL_PROPOSITIONS = ["framework", "auth_method", "database"];
var Q_VALUE_ORDER = {
  framework: 100,
  database: 90,
  auth_method: 80,
  hosting: 60,
  language: 50,
  testing: 30
};
var PROPOSITION_OPTIONS = {
  framework: ["FastAPI", "Express", "Django", "Flask", "NestJS", "Rails", "Spring", "Hono"],
  auth_method: ["JWT", "OAuth", "Session", "API Key", "SAML", "OIDC"],
  database: ["PostgreSQL", "MySQL", "SQLite", "MongoDB", "Redis", "DynamoDB"],
  hosting: ["AWS", "GCP", "Azure", "Vercel", "Heroku", "Railway", "Fly.io"],
  language: ["Python", "TypeScript", "JavaScript", "Go", "Rust", "Java", "Ruby"],
  testing: ["pytest", "Jest", "Vitest", "Mocha", "JUnit", "RSpec"]
};
var PROPOSITION_WHY = {
  framework: "The framework choice impacts architecture, dependencies, and development patterns.",
  auth_method: "Authentication choice affects security architecture and integration complexity.",
  database: "Database selection impacts data modeling, scalability, and query patterns.",
  hosting: "Hosting platform choice affects deployment, scaling, and operational complexity.",
  language: "Language choice depends on team expertise, ecosystem, and performance needs.",
  testing: "Testing framework choice affects test structure and CI/CD integration."
};
function findFirstMatch(prompt, pattern) {
  const match = prompt.match(pattern);
  return match?.index ?? -1;
}
function isImplementationTask(prompt) {
  if (!prompt?.trim()) return false;
  const implPos = findFirstMatch(prompt, IMPL_PATTERNS);
  const nonImplPos = findFirstMatch(prompt, NON_IMPL_PATTERNS);
  if (implPos === -1) return false;
  if (nonImplPos === -1) return true;
  return implPos < nonImplPos;
}
function toTitleCase(str) {
  return str.split("_").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}
function extractPropositions(prompt) {
  const propositions = {};
  if (!prompt?.trim()) {
    for (const propName of Object.keys(PROPOSITION_PATTERNS)) {
      propositions[propName] = "UNKNOWN";
    }
    return propositions;
  }
  for (const [propName, pattern] of Object.entries(PROPOSITION_PATTERNS)) {
    const match = prompt.match(pattern);
    if (match) {
      let value = match[0].toLowerCase();
      if (value === "nest.js") value = "nestjs";
      if (value === "postgres") value = "postgresql";
      if (value.startsWith("oauth")) value = "oauth";
      propositions[propName] = value;
    } else {
      propositions[propName] = "UNKNOWN";
    }
  }
  return propositions;
}
function generateClarificationQuestions(unknowns) {
  if (unknowns.length === 0) {
    return [];
  }
  const sortedUnknowns = [...unknowns].sort((a, b) => {
    const qA = Q_VALUE_ORDER[a] ?? 10;
    const qB = Q_VALUE_ORDER[b] ?? 10;
    return qB - qA;
  });
  return sortedUnknowns.map((proposition) => ({
    header: toTitleCase(proposition),
    proposition,
    options: PROPOSITION_OPTIONS[proposition] ?? ["Other (specify)"],
    why: PROPOSITION_WHY[proposition] ?? `The ${proposition} choice impacts the overall architecture and implementation.`
  }));
}
function formatGateStatus(gates) {
  const statusChars = {
    pass: "\u2713",
    // checkmark
    block: "\u2717",
    // X mark
    pending: "\u25CB"
    // circle
  };
  const eChar = statusChars[gates.erotetic];
  const rChar = statusChars[gates.resources];
  const cChar = statusChars[gates.composition];
  return `E:${eChar} R:${rChar} C:${cChar}`;
}
function evaluateEroteticGate(prompt) {
  if (!isImplementationTask(prompt)) {
    return {
      decision: "continue",
      unknowns: []
    };
  }
  const propositions = extractPropositions(prompt);
  const unknowns = CRITICAL_PROPOSITIONS.filter(
    (prop) => propositions[prop] === "UNKNOWN"
  );
  if (unknowns.length === 0) {
    return {
      decision: "continue",
      unknowns: []
    };
  }
  const feedback = generateBlockFeedback("Erotetic", unknowns);
  return {
    decision: "block",
    unknowns,
    feedback
  };
}
function generateBlockFeedback(gate, unknowns, suggestions) {
  const unknownsList = unknowns.length > 0 ? unknowns.join(", ") : "general requirements";
  return {
    gate,
    status: "block",
    title: `Missing ${unknowns.length} critical proposition(s) to resolve`,
    details: `The following must be clarified before proceeding: ${unknownsList}`,
    suggestion: suggestions?.[0] ?? `Please specify the missing values using AskUserQuestion or select from options.`
  };
}

// src/shared/erotetic-questions.ts
var MAX_QUESTIONS = 4;
var IMPLEMENTATION_QHEURISTICS = [
  {
    id: "auth_method",
    question: "What authentication method should be used?",
    options: [
      { label: "JWT", description: "JSON Web Tokens - stateless, good for APIs" },
      { label: "OAuth2", description: "OAuth 2.0 - for third-party auth integration" },
      { label: "API Key", description: "Simple API key authentication" },
      { label: "Session", description: "Server-side session with cookies" },
      { label: "None", description: "No authentication needed" }
    ],
    default: "None",
    inferFrom: "jwt|oauth|api.?key|session|bearer|token"
  },
  {
    id: "test_coverage",
    question: "What level of test coverage is needed?",
    options: [
      { label: "Full TDD", description: "Write tests first, comprehensive coverage" },
      { label: "Unit Tests", description: "Core logic unit tests only" },
      { label: "Integration", description: "Integration tests for main flows" },
      { label: "Manual", description: "Manual testing only, no automated tests" }
    ],
    default: "Unit Tests",
    inferFrom: "tdd|test.?driven|unit.?test|integration|e2e"
  },
  {
    id: "target_files",
    question: "Which files or directories should be modified?",
    options: [
      { label: "Specific", description: "Specific files mentioned in the request" },
      { label: "Auto-detect", description: "Let me find the relevant files" },
      { label: "New Only", description: "Only create new files, don't modify existing" }
    ],
    default: "Auto-detect",
    inferFrom: "\\.(ts|js|py|go|rs|java)\\b|src\\/|lib\\/|tests?\\/|components?\\/|scripts\\/"
  }
];
var DEBUG_QHEURISTICS = [
  {
    id: "error_type",
    question: "What type of error are you seeing?",
    options: [
      { label: "Runtime", description: "Error occurs during execution" },
      { label: "Compile", description: "Error during build/compile" },
      { label: "Logic", description: "Wrong behavior but no error" },
      { label: "Performance", description: "Slow or resource issues" },
      { label: "Unknown", description: "Not sure what type" }
    ],
    default: "Unknown",
    inferFrom: "runtime|compile|build|logic|performance|slow|memory|crash"
  },
  {
    id: "scope",
    question: "What is the scope of the issue?",
    options: [
      { label: "Single File", description: "Issue is in one file" },
      { label: "Module", description: "Issue affects a module/package" },
      { label: "System", description: "Issue is system-wide" },
      { label: "Unknown", description: "Not sure of the scope" }
    ],
    default: "Unknown",
    inferFrom: "in \\w+\\.(ts|js|py)|module|package|system|everywhere|all"
  },
  {
    id: "investigation_depth",
    question: "How deep should the investigation go?",
    options: [
      { label: "Quick Fix", description: "Find the immediate issue and fix it" },
      { label: "Root Cause", description: "Find and fix the root cause" },
      { label: "Full Audit", description: "Comprehensive review of related code" }
    ],
    default: "Root Cause",
    inferFrom: "quick|immediate|root.?cause|audit|comprehensive|thorough"
  }
];
var RESEARCH_QHEURISTICS = [
  {
    id: "depth",
    question: "How deep should the research go?",
    options: [
      { label: "Overview", description: "High-level summary only" },
      { label: "Standard", description: "Balanced depth with key details" },
      { label: "Deep Dive", description: "Comprehensive, detailed analysis" }
    ],
    default: "Standard",
    inferFrom: "overview|summary|brief|deep|comprehensive|detailed|thorough"
  },
  {
    id: "sources",
    question: "What sources should be consulted?",
    options: [
      { label: "Docs Only", description: "Official documentation only" },
      { label: "Codebase", description: "Search this codebase for patterns" },
      { label: "External", description: "External resources (web, papers)" },
      { label: "All", description: "All available sources" }
    ],
    default: "All",
    inferFrom: "docs?|documentation|codebase|code|web|external|papers?|research"
  },
  {
    id: "output_format",
    question: "What format should the output be in?",
    options: [
      { label: "Summary", description: "Concise bullet points" },
      { label: "Report", description: "Structured document with sections" },
      { label: "Code Examples", description: "Working code examples" },
      { label: "Comparison", description: "Pros/cons comparison table" }
    ],
    default: "Summary",
    inferFrom: "summary|report|examples?|code|comparison|table|compare"
  }
];
var PLANNING_QHEURISTICS = [
  {
    id: "detail_level",
    question: "How detailed should the plan be?",
    options: [
      { label: "High-Level", description: "Major phases only" },
      { label: "Standard", description: "Phases with key tasks" },
      { label: "Detailed", description: "Step-by-step with subtasks" }
    ],
    default: "Standard",
    inferFrom: "high.?level|detailed|step.?by.?step|phases?|outline"
  },
  {
    id: "include_timeline",
    question: "Should the plan include time estimates?",
    options: [
      { label: "Yes", description: "Include time estimates per phase" },
      { label: "No", description: "No time estimates needed" },
      { label: "Rough", description: "Only rough total estimate" }
    ],
    default: "No",
    inferFrom: "time|estimate|hours?|days?|deadline|timeline|schedule"
  },
  {
    id: "include_risks",
    question: "Should the plan include risk analysis?",
    options: [
      { label: "Yes", description: "Include risks and mitigations" },
      { label: "No", description: "Skip risk analysis" },
      { label: "Brief", description: "Just major risks" }
    ],
    default: "No",
    inferFrom: "risk|mitigation|contingency|fallback|backup"
  }
];
var TASK_QHEURISTICS = {
  implementation: IMPLEMENTATION_QHEURISTICS,
  debug: DEBUG_QHEURISTICS,
  research: RESEARCH_QHEURISTICS,
  planning: PLANNING_QHEURISTICS
};
function getQHeuristicsForTask(taskType) {
  const normalizedType = taskType.toLowerCase().trim();
  if (normalizedType in TASK_QHEURISTICS) {
    return TASK_QHEURISTICS[normalizedType];
  }
  return [];
}
function resolveFromContext(prompt, qHeuristics) {
  const resolved = {};
  const unresolved = [];
  const promptLower = prompt.toLowerCase();
  for (const q of qHeuristics) {
    let isResolved = false;
    if (q.inferFrom) {
      try {
        const pattern = new RegExp(q.inferFrom, "i");
        const match = pattern.exec(promptLower);
        if (match) {
          const matchedText = match[0].toLowerCase();
          const resolvedValue = inferOptionFromMatch(q.id, matchedText);
          if (resolvedValue) {
            resolved[q.id] = resolvedValue;
            isResolved = true;
          }
        }
      } catch {
      }
    }
    if (!isResolved) {
      unresolved.push(q);
    }
  }
  return { resolved, unresolved };
}
var INFERENCE_RULES = {
  auth_method: [
    { keywords: ["jwt", "bearer"], value: "JWT" },
    { keywords: ["oauth"], value: "OAuth2" },
    { keywords: ["session"], value: "Session" },
    { keywords: ["token"], value: "JWT" }
  ],
  test_coverage: [
    { keywords: ["tdd", "test driven"], value: "Full TDD" },
    { keywords: ["unit"], value: "Unit Tests" },
    { keywords: ["integration", "e2e"], value: "Integration" }
  ],
  target_files: [
    { patterns: [/\.(ts|js|py|go|rs|java)\b/, /src\/|lib\/|tests?\/|components?\/|scripts\//], value: "Specific" }
  ],
  error_type: [
    { keywords: ["runtime", "crash"], value: "Runtime" },
    { keywords: ["compile", "build"], value: "Compile" },
    { keywords: ["logic", "wrong"], value: "Logic" },
    { keywords: ["performance", "slow", "memory"], value: "Performance" }
  ],
  scope: [
    { patterns: [/in \w+\.(ts|js|py)/], value: "Single File" },
    { keywords: ["module", "package"], value: "Module" },
    { keywords: ["system", "everywhere", "all"], value: "System" }
  ],
  investigation_depth: [
    { keywords: ["quick", "immediate"], value: "Quick Fix" },
    { keywords: ["root", "cause"], value: "Root Cause" },
    { keywords: ["audit", "comprehensive", "thorough"], value: "Full Audit" }
  ],
  depth: [
    { keywords: ["overview", "summary", "brief"], value: "Overview" },
    { keywords: ["deep", "comprehensive", "detailed"], value: "Deep Dive" }
  ],
  sources: [
    { keywords: ["doc"], value: "Docs Only" },
    { keywords: ["codebase", "code"], value: "Codebase" },
    { keywords: ["web", "external", "paper"], value: "External" }
  ],
  output_format: [
    { keywords: ["summary"], value: "Summary" },
    { keywords: ["report"], value: "Report" },
    { keywords: ["example", "code"], value: "Code Examples" },
    { keywords: ["comparison", "compare", "table"], value: "Comparison" }
  ],
  detail_level: [
    { keywords: ["high level", "outline"], value: "High-Level" },
    { keywords: ["detailed", "step"], value: "Detailed" }
  ],
  include_timeline: [
    { keywords: ["time", "estimate", "deadline", "schedule", "timeline"], value: "Yes" }
  ],
  include_risks: [
    { keywords: ["risk", "mitigation", "contingency", "fallback"], value: "Yes" }
  ]
};
function matchesKeyword(text, keywords) {
  return keywords.some((keyword) => text.includes(keyword));
}
function matchesPattern(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}
function ruleMatches(text, rule) {
  if (rule.keywords && matchesKeyword(text, rule.keywords)) {
    return true;
  }
  if (rule.patterns && matchesPattern(text, rule.patterns)) {
    return true;
  }
  return false;
}
function inferOptionFromMatch(qId, matchedText) {
  const text = matchedText.toLowerCase();
  const rules = INFERENCE_RULES[qId];
  if (!rules) {
    return null;
  }
  if (qId === "auth_method" && text.includes("api") && text.includes("key")) {
    return "API Key";
  }
  const matchingRule = rules.find((rule) => ruleMatches(text, rule));
  return matchingRule?.value ?? null;
}
function formatAskUserQuestions(unresolved) {
  const questionsToAsk = unresolved.slice(0, MAX_QUESTIONS);
  const questions = questionsToAsk.map((q) => ({
    id: q.id,
    question: q.question,
    options: q.options.map((o) => ({ label: o.label, description: o.description })),
    optional: q.default !== void 0,
    defaultValue: q.default
  }));
  const remainingCount = unresolved.length - MAX_QUESTIONS;
  const context = remainingCount > 0 ? `I have ${questionsToAsk.length} questions to clarify your request. (${remainingCount} more will follow)` : `I have ${questionsToAsk.length} questions to clarify your request.`;
  return {
    questions,
    context
  };
}

// src/shared/erotetic-termination.ts
var MAX_QUESTIONS_TOTAL = 4;
var USE_DEFAULTS_PATTERNS = [
  /\bjust\s+use\s+defaults?\b/i,
  /\bgo\s+with\s+defaults?\b/i,
  /\buse\s+(the\s+)?default\s+values?\b/i,
  /\bpick\s+for\s+me\b/i,
  /\byou\s+decide\b/i,
  /\bwhatever\s+works\b/i,
  /\byour\s+choice\b/i,
  /\byou\s+choose\b/i,
  /\bdefaults?\s+(are\s+)?fine\b/i,
  /\bi\s+don'?t\s+care\b/i
];
function detectDefaultsIntent(response) {
  const text = response.toLowerCase().trim();
  return USE_DEFAULTS_PATTERNS.some((pattern) => pattern.test(text));
}
function applyDefaults(resolved, unresolved) {
  const result = { ...resolved };
  for (const q of unresolved) {
    if (!(q.id in result)) {
      result[q.id] = q.default ?? "";
    }
  }
  return result;
}
function checkTermination(state) {
  const { resolved, unresolved, questionsAsked, userRequestedDefaults } = state;
  if (unresolved.length === 0) {
    return {
      shouldTerminate: true,
      reason: "all_resolved",
      finalResolution: { ...resolved }
    };
  }
  if (userRequestedDefaults) {
    return {
      shouldTerminate: true,
      reason: "defaults_requested",
      finalResolution: applyDefaults(resolved, unresolved)
    };
  }
  if (questionsAsked >= MAX_QUESTIONS_TOTAL) {
    return {
      shouldTerminate: true,
      reason: "max_questions",
      finalResolution: applyDefaults(resolved, unresolved)
    };
  }
  return {
    shouldTerminate: false,
    reason: "continue",
    finalResolution: { ...resolved }
    // Return current state
  };
}

// src/shared/pattern-router.ts
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
  "event_driven"
];
function detectPattern() {
  const pattern = process.env.PATTERN_TYPE;
  if (!pattern) return null;
  return pattern;
}
var SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;
function isValidId(id) {
  return SAFE_ID_PATTERN.test(id);
}

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
var SUPPORTED_PATTERNS2 = [
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

// src/shared/composition-gate.ts
var CompositionInvalidError = class extends Error {
  constructor(errors) {
    super(`Invalid composition: ${errors.join("; ")}`);
    this.errors = errors;
    this.name = "CompositionInvalidError";
  }
};
function gate3Composition(patternA, patternB, scope = "handoff", operator = ";") {
  const result = validateComposition(
    [patternA, patternB],
    scope,
    operator
  );
  if (!result.valid) {
    throw new CompositionInvalidError(result.errors);
  }
  return result;
}
function gate3CompositionChain(patterns, scope = "handoff", operator = ";") {
  const result = validateComposition(patterns, scope, operator);
  if (!result.valid) {
    throw new CompositionInvalidError(result.errors);
  }
  return result;
}

// src/shared/resource-reader.ts
import { readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
var DEFAULT_RESOURCE_STATE = {
  freeMemMB: 4096,
  activeAgents: 0,
  maxAgents: 10,
  contextPct: 0
};
function getSessionId() {
  return process.env.CLAUDE_SESSION_ID || String(process.ppid || process.pid);
}
function getResourceFilePath(sessionId) {
  return join(tmpdir(), `claude-resources-${sessionId}.json`);
}
function readResourceState() {
  const sessionId = getSessionId();
  const resourceFile = getResourceFilePath(sessionId);
  if (!existsSync(resourceFile)) {
    return null;
  }
  try {
    const content = readFileSync(resourceFile, "utf-8");
    const data = JSON.parse(content);
    return {
      freeMemMB: typeof data.freeMemMB === "number" ? data.freeMemMB : DEFAULT_RESOURCE_STATE.freeMemMB,
      activeAgents: typeof data.activeAgents === "number" ? data.activeAgents : DEFAULT_RESOURCE_STATE.activeAgents,
      maxAgents: typeof data.maxAgents === "number" ? data.maxAgents : DEFAULT_RESOURCE_STATE.maxAgents,
      contextPct: typeof data.contextPct === "number" ? data.contextPct : DEFAULT_RESOURCE_STATE.contextPct
    };
  } catch {
    return null;
  }
}

// src/shared/resource-utils.ts
import * as os from "os";
function getSystemResources() {
  return {
    freeRAM: os.freemem(),
    totalRAM: os.totalmem(),
    cpuCores: os.cpus().length,
    loadAvg: os.loadavg()
  };
}

// src/shared/skill-router-types.ts
var CircularDependencyError = class extends Error {
  constructor(cyclePath) {
    super(`Circular dependency detected: ${cyclePath.join(" -> ")}`);
    this.cyclePath = cyclePath;
    this.name = "CircularDependencyError";
  }
};

// src/shared/task-detector.ts
var IMPLEMENTATION_INDICATORS = [
  { pattern: /\bimplement\b/i, keyword: "implement", type: "implementation", weight: 0.9 },
  { pattern: /\bbuild\b/i, keyword: "build", type: "implementation", weight: 0.9 },
  { pattern: /\bcreate\b/i, keyword: "create", type: "implementation", weight: 0.8 },
  { pattern: /\badd\s+(a\s+)?feature/i, keyword: "add feature", type: "implementation", weight: 0.85 },
  { pattern: /\bwrite\s+(a\s+)?(function|class|method|component|module)/i, keyword: "write", type: "implementation", weight: 0.85 },
  { pattern: /\bdevelop\b/i, keyword: "develop", type: "implementation", weight: 0.8 },
  { pattern: /\bset\s*up\b/i, keyword: "set up", type: "implementation", weight: 0.7 },
  { pattern: /\bconfigure\b/i, keyword: "configure", type: "implementation", weight: 0.7 },
  { pattern: /\brefactor\b/i, keyword: "refactor", type: "implementation", weight: 0.8 },
  { pattern: /\bmigrate\b/i, keyword: "migrate", type: "implementation", weight: 0.75 }
];
var DEBUG_INDICATORS = [
  { pattern: /\bdebug\b/i, keyword: "debug", type: "debug", weight: 0.9 },
  { pattern: /\bfix\s+(the\s+)?(bug|issue|error|problem)/i, keyword: "fix bug", type: "debug", weight: 0.9 },
  { pattern: /\binvestigate\b/i, keyword: "investigate", type: "debug", weight: 0.85 },
  { pattern: /\btroubleshoot\b/i, keyword: "troubleshoot", type: "debug", weight: 0.85 },
  { pattern: /\bdiagnose\b/i, keyword: "diagnose", type: "debug", weight: 0.8 },
  { pattern: /\bwhy\s+is\s+.*\b(failing|broken|not\s+working)/i, keyword: "why failing", type: "debug", weight: 0.75 },
  { pattern: /\bfix\b/i, keyword: "fix", type: "debug", weight: 0.6 }
];
var RESEARCH_INDICATORS = [
  { pattern: /\bhow\s+do\s+I\b/i, keyword: "how do I", type: "research", weight: 0.85 },
  { pattern: /\bfind\s+out\b/i, keyword: "find out", type: "research", weight: 0.8 },
  { pattern: /\bresearch\b/i, keyword: "research", type: "research", weight: 0.85 },
  { pattern: /\blook\s+into\b/i, keyword: "look into", type: "research", weight: 0.8 },
  { pattern: /\bexplore\s+(the\s+)?(options|possibilities|approaches)/i, keyword: "explore", type: "research", weight: 0.75 },
  { pattern: /\bwhat\s+are\s+(the\s+)?(best\s+practices|options|ways)/i, keyword: "best practices", type: "research", weight: 0.7 },
  { pattern: /\blearn\s+about\b/i, keyword: "learn about", type: "research", weight: 0.7 }
];
var PLANNING_INDICATORS = [
  { pattern: /\bplan\b/i, keyword: "plan", type: "planning", weight: 0.85 },
  { pattern: /\bdesign\b/i, keyword: "design", type: "planning", weight: 0.85 },
  { pattern: /\barchitect\b/i, keyword: "architect", type: "planning", weight: 0.9 },
  { pattern: /\boutline\b/i, keyword: "outline", type: "planning", weight: 0.75 },
  { pattern: /\bstrateg(y|ize)\b/i, keyword: "strategy", type: "planning", weight: 0.8 },
  { pattern: /\bpropose\b/i, keyword: "propose", type: "planning", weight: 0.7 },
  { pattern: /\bstructure\b/i, keyword: "structure", type: "planning", weight: 0.65 }
];
var CONVERSATIONAL_PATTERNS = [
  /\bwhat\s+is\b/i,
  /\bexplain\b/i,
  /\bshow\s+me\b/i,
  /\btell\s+me\s+about\b/i,
  /\bdescribe\b/i,
  /\bcan\s+you\s+explain\b/i,
  /\bhelp\s+me\s+understand\b/i,
  /\bwhat\s+does\b/i,
  /\bhow\s+does\b/i,
  /\bwhy\s+does\b/i,
  /\bwhat's\s+the\s+difference\b/i,
  /\bhello\b/i,
  /\bhi\b/i,
  /\bthanks?\b/i,
  /\bthank\s+you\b/i,
  /\bgreat\b/i,
  /\bnice\b/i,
  /\bgood\s+job\b/i,
  /\bwhat\s+happened\b/i
];
var ALL_TASK_INDICATORS = [
  ...IMPLEMENTATION_INDICATORS,
  ...DEBUG_INDICATORS,
  ...RESEARCH_INDICATORS,
  ...PLANNING_INDICATORS
];
function detectTask(prompt) {
  if (!prompt?.trim()) {
    return {
      isTask: false,
      confidence: 0,
      triggers: []
    };
  }
  const promptLower = prompt.toLowerCase();
  const conversationalMatches = CONVERSATIONAL_PATTERNS.filter((p) => p.test(promptLower));
  const matches = [];
  for (const indicator of ALL_TASK_INDICATORS) {
    if (indicator.pattern.test(promptLower)) {
      matches.push({ indicator, keyword: indicator.keyword });
    }
  }
  if (matches.length === 0) {
    return {
      isTask: false,
      confidence: 0,
      triggers: []
    };
  }
  let totalWeight = 0;
  for (const match of matches) {
    totalWeight += match.indicator.weight;
  }
  let confidence = totalWeight / matches.length;
  const uniqueTypes = new Set(matches.map((m) => m.indicator.type));
  if (uniqueTypes.size > 1) {
    confidence += 0.1;
  }
  if (matches.length > 2) {
    confidence += Math.min(0.05 * (matches.length - 2), 0.15);
  }
  if (conversationalMatches.length > 0) {
    confidence -= 0.3 * conversationalMatches.length;
  }
  if (confidence < 0.4) {
    return {
      isTask: false,
      confidence: Math.max(0, confidence),
      triggers: []
    };
  }
  confidence = Math.min(1, Math.max(0, confidence));
  const sortedMatches = [...matches].sort(
    (a, b) => b.indicator.weight - a.indicator.weight
  );
  const primaryType = sortedMatches[0].indicator.type;
  const triggers = [...new Set(matches.map((m) => m.keyword))];
  return {
    isTask: true,
    taskType: primaryType,
    confidence,
    triggers
  };
}

// src/shared/db-utils.ts
import { spawnSync } from "child_process";
import { existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";
function getDbPath() {
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return join2(
    projectDir,
    ".claude",
    "cache",
    "agentica-coordination",
    "coordination.db"
  );
}
function queryDb(pythonQuery, args) {
  const result = spawnSync("python3", ["-c", pythonQuery, ...args], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024
  });
  if (result.status !== 0) {
    const errorMsg = result.stderr || `Python exited with code ${result.status}`;
    throw new Error(`Python query failed: ${errorMsg}`);
  }
  return result.stdout.trim();
}
function runPythonQuery(script, args) {
  try {
    const result = spawnSync("python3", ["-c", script, ...args], {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024
    });
    return {
      success: result.status === 0,
      stdout: result.stdout?.trim() || "",
      stderr: result.stderr || ""
    };
  } catch (err) {
    return {
      success: false,
      stdout: "",
      stderr: String(err)
    };
  }
}
function registerAgent(agentId, sessionId, pattern = null, pid = null) {
  const dbPath = getDbPath();
  const source = process.env.AGENTICA_SERVER ? "agentica" : "cli";
  const pythonScript = `
import sqlite3
import sys
import os
from datetime import datetime, timezone
from pathlib import Path

db_path = sys.argv[1]
agent_id = sys.argv[2]
session_id = sys.argv[3]
pattern = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'null' else None
pid = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5] != 'null' else None
source = sys.argv[6] if len(sys.argv) > 6 and sys.argv[6] != 'null' else None

try:
    # Ensure directory exists
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")

    # Create table if not exists (with source column)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS agents (
            id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            premise TEXT,
            model TEXT,
            scope_keys TEXT,
            pattern TEXT,
            parent_agent_id TEXT,
            pid INTEGER,
            ppid INTEGER,
            spawned_at TEXT NOT NULL,
            completed_at TEXT,
            status TEXT DEFAULT 'running',
            error_message TEXT,
            source TEXT
        )
    """)

    # Migration: add source column if it doesn't exist
    cursor = conn.execute("PRAGMA table_info(agents)")
    columns = {row[1] for row in cursor.fetchall()}
    if 'source' not in columns:
        conn.execute("ALTER TABLE agents ADD COLUMN source TEXT")

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()
    ppid = os.getppid() if pid else None

    conn.execute(
        """
        INSERT OR REPLACE INTO agents
        (id, session_id, pattern, pid, ppid, spawned_at, status, source)
        VALUES (?, ?, ?, ?, ?, ?, 'running', ?)
        """,
        (agent_id, session_id, pattern, pid, ppid, now, source)
    )
    conn.commit()
    conn.close()
    print("ok")
except Exception as e:
    print(f"error: {e}")
    sys.exit(1)
`;
  const args = [
    dbPath,
    agentId,
    sessionId,
    pattern || "null",
    pid !== null ? String(pid) : "null",
    source
  ];
  const result = runPythonQuery(pythonScript, args);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function completeAgent(agentId, status = "completed", errorMessage = null) {
  const dbPath = getDbPath();
  if (!existsSync2(dbPath)) {
    return { success: true };
  }
  const pythonScript = `
import sqlite3
import sys
from datetime import datetime, timezone

db_path = sys.argv[1]
agent_id = sys.argv[2]
status = sys.argv[3]
error_message = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != 'null' else None

try:
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.execute("PRAGMA journal_mode = WAL")

    # Check if agents table exists
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
    )
    if cursor.fetchone() is None:
        print("ok")
        conn.close()
        sys.exit(0)

    now = datetime.now(timezone.utc).replace(tzinfo=None).isoformat()

    conn.execute(
        """
        UPDATE agents
        SET completed_at = ?, status = ?, error_message = ?
        WHERE id = ?
        """,
        (now, status, error_message, agent_id)
    )
    conn.commit()
    conn.close()
    print("ok")
except Exception as e:
    print(f"error: {e}")
    sys.exit(1)
`;
  const args = [
    dbPath,
    agentId,
    status,
    errorMessage || "null"
  ];
  const result = runPythonQuery(pythonScript, args);
  if (!result.success || result.stdout !== "ok") {
    return {
      success: false,
      error: result.stderr || result.stdout || "Unknown error"
    };
  }
  return { success: true };
}
function getActiveAgentCount() {
  const dbPath = getDbPath();
  if (!existsSync2(dbPath)) {
    return 0;
  }
  const pythonScript = `
import sqlite3
import sys
import os

db_path = sys.argv[1]

try:
    # Check if file exists and is a valid SQLite database
    if not os.path.exists(db_path):
        print("0")
        sys.exit(0)

    conn = sqlite3.connect(db_path)
    # Set busy_timeout to prevent indefinite blocking (Finding 3: STARVATION_FINDINGS.md)
    conn.execute("PRAGMA busy_timeout = 5000")
    # Enable WAL mode for better concurrent access
    conn.execute("PRAGMA journal_mode = WAL")

    # Check if agents table exists
    cursor = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='agents'"
    )
    if cursor.fetchone() is None:
        print("0")
        conn.close()
        sys.exit(0)

    # Query running agent count
    cursor = conn.execute("SELECT COUNT(*) FROM agents WHERE status = 'running'")
    count = cursor.fetchone()[0]
    conn.close()
    print(count)
except Exception:
    print("0")
`;
  const result = runPythonQuery(pythonScript, [dbPath]);
  if (!result.success) {
    return 0;
  }
  const count = parseInt(result.stdout, 10);
  return isNaN(count) ? 0 : count;
}

// src/shared/memory-client.ts
import { spawnSync as spawnSync2 } from "child_process";
var MemoryClient = class {
  sessionId;
  agentId;
  timeoutMs;
  projectDir;
  constructor(options = {}) {
    this.sessionId = options.sessionId || "default";
    this.agentId = options.agentId || null;
    this.timeoutMs = options.timeoutMs || 5e3;
    this.projectDir = options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  }
  /**
   * Search for similar content in memory.
   *
   * Uses the Python memory service's search functionality.
   * Returns empty array on any error (graceful fallback).
   *
   * @param query - Natural language search query
   * @param limit - Maximum number of results (default: 5)
   * @returns Array of matching results sorted by relevance
   */
  searchSimilar(query, limit = 5) {
    if (!query || !query.trim()) {
      return [];
    }
    const pythonScript = this.buildSearchScript();
    const args = [query, String(limit), this.sessionId];
    if (this.agentId) {
      args.push(this.agentId);
    }
    const result = this.runPython(pythonScript, args);
    if (!result.success) {
      if (process.env.DEBUG) {
        console.error("Memory search failed:", result.stderr);
      }
      return [];
    }
    try {
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map(this.normalizeResult);
    } catch {
      return [];
    }
  }
  /**
   * Store content in memory.
   *
   * @param content - The content to store
   * @param metadata - Optional metadata to attach
   * @returns Memory ID if successful, null on failure
   */
  store(content, metadata = {}) {
    if (!content || !content.trim()) {
      return null;
    }
    const pythonScript = this.buildStoreScript();
    const args = [
      content,
      JSON.stringify(metadata),
      this.sessionId
    ];
    if (this.agentId) {
      args.push(this.agentId);
    }
    const result = this.runPython(pythonScript, args);
    if (!result.success) {
      if (process.env.DEBUG) {
        console.error("Memory store failed:", result.stderr);
      }
      return null;
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed.id || null;
    } catch {
      return null;
    }
  }
  /**
   * Check if memory service is available.
   *
   * @returns true if memory service is reachable
   */
  isAvailable() {
    const pythonScript = `
import json
import sys
try:
    from scripts.core.db.memory_factory import get_default_backend
    backend = get_default_backend()
    print(json.dumps({"available": True, "backend": backend}))
except Exception as e:
    print(json.dumps({"available": False, "error": str(e)}))
`;
    const result = this.runPython(pythonScript, []);
    if (!result.success) {
      return false;
    }
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed.available === true;
    } catch {
      return false;
    }
  }
  /**
   * Build Python script for memory search.
   */
  buildSearchScript() {
    return `
import json
import sys
import asyncio
import os

# Add project to path for imports
project_dir = os.environ.get('CLAUDE_PROJECT_DIR', os.getcwd())
sys.path.insert(0, project_dir)

async def search():
    query = sys.argv[1]
    limit = int(sys.argv[2])
    session_id = sys.argv[3]
    agent_id = sys.argv[4] if len(sys.argv) > 4 else None

    try:
        from scripts.core.db.memory_factory import create_default_memory_service
        memory = create_default_memory_service(session_id)

        await memory.connect()

        # Try vector search first, fall back to text search
        results = await memory.search(query, limit=limit)

        await memory.close()

        # Convert to JSON-safe format with normalized field names
        safe_results = []
        for r in results:
            safe_results.append({
                "content": r.get("content", ""),
                # Use similarity if available, otherwise rank (BM25)
                "similarity": float(r.get("similarity", r.get("rank", 0.0))),
                "metadata": r.get("metadata", {})
            })

        print(json.dumps(safe_results))
    except Exception as e:
        # Return empty array on error - graceful fallback
        print(json.dumps([]))
        sys.exit(0)  # Exit 0 to avoid breaking the hook

asyncio.run(search())
`;
  }
  /**
   * Build Python script for memory store.
   */
  buildStoreScript() {
    return `
import json
import sys
import asyncio
import os

# Add project to path for imports
project_dir = os.environ.get('CLAUDE_PROJECT_DIR', os.getcwd())
sys.path.insert(0, project_dir)

async def store():
    content = sys.argv[1]
    metadata = json.loads(sys.argv[2])
    session_id = sys.argv[3]
    agent_id = sys.argv[4] if len(sys.argv) > 4 else None

    try:
        from scripts.core.db.memory_factory import create_default_memory_service
        memory = create_default_memory_service(session_id)

        await memory.connect()

        memory_id = await memory.store(content, metadata=metadata)

        await memory.close()

        print(json.dumps({"id": memory_id}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

asyncio.run(store())
`;
  }
  /**
   * Execute Python script via subprocess.
   */
  runPython(script, args) {
    try {
      const result = spawnSync2("python3", ["-c", script, ...args], {
        encoding: "utf-8",
        maxBuffer: 1024 * 1024,
        timeout: this.timeoutMs,
        cwd: this.projectDir,
        env: {
          ...process.env,
          CLAUDE_PROJECT_DIR: this.projectDir
        }
      });
      return {
        success: result.status === 0,
        stdout: result.stdout?.trim() || "",
        stderr: result.stderr || ""
      };
    } catch (err) {
      return {
        success: false,
        stdout: "",
        stderr: String(err)
      };
    }
  }
  /**
   * Normalize a search result to the standard interface.
   */
  normalizeResult(raw) {
    return {
      content: String(raw.content || ""),
      similarity: typeof raw.similarity === "number" ? raw.similarity : 0,
      metadata: raw.metadata || {}
    };
  }
};
function searchMemory(query, limit = 5, options = {}) {
  const client = new MemoryClient(options);
  return client.searchSimilar(query, limit);
}
function storeMemory(content, metadata = {}, options = {}) {
  const client = new MemoryClient(options);
  return client.store(content, metadata);
}
function isMemoryAvailable(options = {}) {
  const client = new MemoryClient(options);
  return client.isAvailable();
}
function trackUsage(record, options = {}) {
  const content = `Skill usage: ${record.skillName || "unknown"} via ${record.source} (confidence: ${record.confidence.toFixed(2)})`;
  const metadata = {
    type: "skill_usage",
    usageType: record.type,
    skillName: record.skillName,
    source: record.source,
    confidence: record.confidence,
    timestamp: record.timestamp,
    sessionId: record.sessionId
  };
  return storeMemory(content, metadata, options);
}
function recordSkillUsage(skillName, source, confidence, sessionId, options = {}) {
  const record = {
    type: "skill_match",
    skillName,
    source,
    confidence,
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    sessionId
  };
  return trackUsage(record, options);
}
export {
  CRITICAL_PROPOSITIONS,
  CircularDependencyError,
  CompositionInvalidError,
  DEFAULT_RESOURCE_STATE,
  MAX_QUESTIONS,
  MAX_QUESTIONS_TOTAL,
  MemoryClient,
  SUPPORTED_PATTERNS2 as PATTERN_LIST,
  PROPOSITION_PATTERNS,
  Q_VALUE_ORDER,
  SAFE_ID_PATTERN,
  SUPPORTED_PATTERNS,
  applyDefaults,
  callPatternInference,
  callValidateComposition,
  checkTermination,
  completeAgent,
  detectDefaultsIntent,
  detectPattern,
  detectTask,
  evaluateEroteticGate,
  extractPropositions,
  formatAskUserQuestions,
  formatGateStatus,
  gate3Composition,
  gate3CompositionChain,
  generateBlockFeedback,
  generateClarificationQuestions,
  getActiveAgentCount,
  getDbPath,
  getQHeuristicsForTask,
  getResourceFilePath,
  getSessionId,
  getSystemResources,
  isImplementationTask,
  isMemoryAvailable,
  isValidId,
  queryDb,
  readResourceState,
  recordSkillUsage,
  registerAgent,
  resolveFromContext,
  runPythonQuery,
  searchMemory,
  selectPattern,
  storeMemory,
  trackUsage,
  validateComposition
};
