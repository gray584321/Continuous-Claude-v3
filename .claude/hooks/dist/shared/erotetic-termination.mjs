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
export {
  MAX_QUESTIONS_TOTAL,
  applyDefaults,
  checkTermination,
  detectDefaultsIntent
};
