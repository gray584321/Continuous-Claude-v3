"""Learning quality scorer for confidence gating in store_learning.py.

Provides content quality assessment to prevent low-quality learnings from
cluttering the semantic memory system.

Usage:
    from scripts.core.learning_scorer import scorer, ConfidenceLevel

    score = scorer.score(content, {"type": learning_type})
    if scorer.should_store(score):
        # safe to store
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class ConfidenceLevel(Enum):
    """Confidence level enum for learning quality."""
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"


class LearningType(Enum):
    """Suggested learning type enum."""
    FAILED_APPROACH = "FAILED_APPROACH"
    WORKING_SOLUTION = "WORKING_SOLUTION"
    USER_PREFERENCE = "USER_PREFERENCE"
    CODEBASE_PATTERN = "CODEBASE_PATTERN"
    ARCHITECTURAL_DECISION = "ARCHITECTURAL_DECISION"
    ERROR_FIX = "ERROR_FIX"
    OPEN_THREAD = "OPEN_THREAD"


@dataclass
class LearningScore:
    """Result of scoring a learning for quality."""
    confidence: float  # 0.0 to 1.0
    confidence_level: ConfidenceLevel
    quality_signals: list[str]
    suggested_type: LearningType | None


class LearningScorer:
    """Scores learning content for quality and suggests type."""

    # Thresholds for confidence levels
    HIGH_THRESHOLD = 0.7
    MEDIUM_THRESHOLD = 0.4

    # Content quality indicators
    GOOD_SIGNALS = [
        "specific",
        "actionable",
        "has context",
        "has examples",
        "clear conclusion",
    ]

    BAD_SIGNALS = [
        "too vague",
        "too short",
        "no context",
        "just notes",
        "incomplete",
    ]

    # Type detection patterns
    TYPE_PATTERNS = {
        LearningType.FAILED_APPROACH: [
            "didn't work", "failed", "error", "broken", "couldn't",
            "avoid", "problem", "issue", "wrong approach",
        ],
        LearningType.WORKING_SOLUTION: [
            "worked", "success", "fixed", "solved", "solution",
            "correct", "proper", "best practice",
        ],
        LearningType.USER_PREFERENCE: [
            "prefer", "like", "dislike", "style", "convention",
            "always", "never", "user wants",
        ],
        LearningType.CODEBASE_PATTERN: [
            "pattern", "structure", "architecture", "module",
            "design", "organization", "convention",
        ],
        LearningType.ARCHITECTURAL_DECISION: [
            "chose", "decision", "because", "instead of", "trade-off",
            "alternatives", "reasoning", "selected",
        ],
        LearningType.ERROR_FIX: [
            "error", "exception", "traceback", "fix", "patch",
            "workaround", "caught", "handle",
        ],
        LearningType.OPEN_THREAD: [
            "todo", "future", "later", "need to", "pending",
            "unfinished", "wip", "follow-up",
        ],
    }

    def score(
        self,
        content: str,
        metadata: dict[str, Any] | None = None,
    ) -> LearningScore:
        """Score learning content for quality.

        Args:
            content: The learning content to score
            metadata: Optional metadata including learning type

        Returns:
            LearningScore with confidence, signals, and type suggestion
        """
        if not content or not content.strip():
            return LearningScore(
                confidence=0.0,
                confidence_level=ConfidenceLevel.LOW,
                quality_signals=["empty content"],
                suggested_type=None,
            )

        content_lower = content.lower()
        word_count = len(content.split())

        quality_signals: list[str] = []

        # Length checks
        if word_count < 10:
            quality_signals.append("too short")
        elif word_count >= 20:
            quality_signals.append("good length")
        else:
            quality_signals.append("adequate length")

        # Context detection
        has_context = any(
            indicator in content_lower
            for indicator in ["because", "when", "where", "context", "situation"]
        )
        if has_context:
            quality_signals.append("has context")
        else:
            quality_signals.append("lacks context")

        # Specificity detection
        has_specifics = any(
            indicator in content_lower
            for indicator in ["file:", "line", "function", "class", "error:", "python", "javascript"]
        )
        if has_specifics:
            quality_signals.append("specific details")
        else:
            quality_signals.append("general statement")

        # Actionable detection
        has_action = any(
            indicator in content_lower
            for indicator in ["use", "try", "avoid", "instead", "should", "must", "don't"]
        )
        if has_action:
            quality_signals.append("actionable")
        else:
            quality_signals.append("not actionable")

        # Conclusion/result detection
        has_result = any(
            indicator in content_lower
            for indicator in ["works", "fixes", "solves", "result", "outcome", "therefore"]
        )
        if has_result:
            quality_signals.append("has conclusion")
        else:
            quality_signals.append("no clear conclusion")

        # Detect suggested type
        suggested_type = self._detect_type(content_lower, metadata)

        # Calculate confidence score
        base_score = 0.5  # Start at medium

        # Adjust for signals
        if "too short" not in quality_signals:
            base_score += 0.1
        if "has context" in quality_signals:
            base_score += 0.1
        if "specific details" in quality_signals:
            base_score += 0.1
        if "actionable" in quality_signals:
            base_score += 0.1
        if "has conclusion" in quality_signals:
            base_score += 0.1

        # Penalize for bad signals
        if "too short" in quality_signals:
            base_score -= 0.2
        if "lacks context" in quality_signals:
            base_score -= 0.1
        if "no clear conclusion" in quality_signals:
            base_score -= 0.1

        # Clamp score
        confidence = max(0.0, min(1.0, base_score))

        # Determine confidence level
        if confidence >= self.HIGH_THRESHOLD:
            confidence_level = ConfidenceLevel.HIGH
        elif confidence >= self.MEDIUM_THRESHOLD:
            confidence_level = ConfidenceLevel.MEDIUM
        else:
            confidence_level = ConfidenceLevel.LOW

        return LearningScore(
            confidence=confidence,
            confidence_level=confidence_level,
            quality_signals=quality_signals,
            suggested_type=suggested_type,
        )

    def _detect_type(
        self,
        content_lower: str,
        metadata: dict[str, Any] | None = None,
    ) -> LearningType | None:
        """Detect the learning type from content patterns.

        Args:
            content_lower: Lowercased content for pattern matching
            metadata: Optional metadata that might include type

        Returns:
            Detected LearningType or None
        """
        # If type is in metadata, return it
        if metadata and "type" in metadata:
            provided_type = metadata["type"]
            try:
                return LearningType(provided_type)
            except ValueError:
                pass

        # Score content for each type
        type_scores: dict[LearningType, int] = {}

        for learn_type, patterns in self.TYPE_PATTERNS.items():
            score = sum(1 for pattern in patterns if pattern in content_lower)
            type_scores[learn_type] = score

        # Find type with highest score (min score of 2 to qualify)
        best_type = max(
            (t for t, s in type_scores.items() if s >= 2),
            key=lambda t: type_scores[t],
            default=None,
        )

        return best_type

    def should_store(
        self,
        score: LearningScore,
        threshold: str = "medium",
    ) -> bool:
        """Determine if a learning should be stored based on score.

        Args:
            score: The LearningScore to evaluate
            threshold: Storage threshold (high/medium/low)

        Returns:
            True if learning meets threshold, False otherwise
        """
        thresholds = {
            "high": ConfidenceLevel.HIGH,
            "medium": ConfidenceLevel.MEDIUM,
            "low": ConfidenceLevel.LOW,
        }

        required_level = thresholds.get(threshold.lower(), ConfidenceLevel.MEDIUM)

        # Convert score confidence to level for comparison
        return score.confidence_level.value >= required_level.value


# Global scorer instance
scorer = LearningScorer()
