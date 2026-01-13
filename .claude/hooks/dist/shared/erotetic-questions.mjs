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
export {
  MAX_QUESTIONS,
  formatAskUserQuestions,
  getQHeuristicsForTask,
  resolveFromContext
};
