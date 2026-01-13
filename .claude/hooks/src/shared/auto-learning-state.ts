/**
 * Auto Learning State - Shared module for tracking recent edits
 *
 * Tracks recent edits for context and prevents duplicate extractions
 * during a session. Uses in-memory storage (per-session scope).
 *
 * Part of the pattern-aware hooks infrastructure.
 */

export interface EditEntry {
  file: string;
  type: string;
  timestamp: number;
}

export interface LearningState {
  recentEdits: EditEntry[];
  addEdit(file: string, type: string): void;
  isDuplicate(file: string, windowMs?: number): boolean;
  cleanup(): void;
}

/**
 * Create a new learning state instance
 */
export function createLearningState(): LearningState {
  // In-memory storage - per-session scope
  const recentEdits: EditEntry[] = [];
  const MAX_EDITS = 10;

  function addEdit(file: string, type: string): void {
    const entry: EditEntry = {
      file,
      type,
      timestamp: Date.now()
    };

    recentEdits.push(entry);

    // Keep only the last MAX_EDITS entries (FIFO)
    while (recentEdits.length > MAX_EDITS) {
      recentEdits.shift();
    }
  }

  function isDuplicate(file: string, windowMs: number = 30000): boolean {
    const now = Date.now();

    // Check if same file was edited within the time window
    return recentEdits.some(
      entry => entry.file === file && (now - entry.timestamp) < windowMs
    );
  }

  function cleanup(): void {
    recentEdits.length = 0;
  }

  return {
    get recentEdits() {
      return [...recentEdits]; // Return copy to prevent external mutation
    },
    addEdit,
    isDuplicate,
    cleanup
  };
}

/**
 * Singleton instance for shared use across hooks in a session
 */
let instance: LearningState | null = null;

export function getLearningState(): LearningState {
  if (!instance) {
    instance = createLearningState();
  }
  return instance;
}

export function resetLearningState(): void {
  if (instance) {
    instance.cleanup();
    instance = null;
  }
}
