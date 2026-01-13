// src/shared/skill-router-types.ts
var CircularDependencyError = class extends Error {
  constructor(cyclePath) {
    super(`Circular dependency detected: ${cyclePath.join(" -> ")}`);
    this.cyclePath = cyclePath;
    this.name = "CircularDependencyError";
  }
};
export {
  CircularDependencyError
};
