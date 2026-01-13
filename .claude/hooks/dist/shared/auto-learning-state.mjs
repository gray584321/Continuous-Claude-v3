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
function resetLearningState() {
  if (instance) {
    instance.cleanup();
    instance = null;
  }
}
export {
  createLearningState,
  getLearningState,
  resetLearningState
};
