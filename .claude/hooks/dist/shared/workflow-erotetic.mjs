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
export {
  CRITICAL_PROPOSITIONS,
  PROPOSITION_PATTERNS,
  Q_VALUE_ORDER,
  evaluateEroteticGate,
  extractPropositions,
  formatGateStatus,
  generateBlockFeedback,
  generateClarificationQuestions,
  isImplementationTask
};
