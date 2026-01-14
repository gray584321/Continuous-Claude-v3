
class RerankerProvider:
    """Cross-encoder reranker for reordering search results.

    Rerankers take query-document pairs and output relevance scores.
    Used after vector search to improve result quality.

    Supported models:
    - Qwen/Qwen3-Reranker-0.6B: Qwen3 reranker (default, 1024 dims)
    - Qwen/Qwen3-Reranker-1.5B: Higher capacity Qwen reranker (1024 dims)
    - BAAI/bge-reranker-base: Good cross-encoder reranker (768 dims)
    - BAAI/bge-reranker-large: Higher quality, more memory (1024 dims)
    - Thenlper/gte-reranker-base: GTE-based reranker (768 dims)

    Usage:
        reranker = RerankerProvider()
        scores = await reranker.rerank("query", ["doc1", "doc2", "doc3"])
        # scores = [0.92, 0.45, 0.31] - higher = more relevant
    """

    MODELS = {
        "Qwen/Qwen3-Reranker-0.6B": 1024,
        "Qwen/Qwen3-Reranker-1.5B": 1024,
        "BAAI/bge-reranker-base": 768,
        "BAAI/bge-reranker-large": 1024,
        "Thenlper/gte-reranker-base": 768,
    }

    def __init__(
        self,
        model: str = "Qwen/Qwen3-Reranker-0.6B",
        device: str | None = None,
        batch_size: int = 32,
    ):
        """Initialize reranker provider.

        Args:
            model: Model name from sentence-transformers
            device: Device to use ('cpu', 'cuda', 'mps', or None for auto)
            batch_size: Maximum documents per batch
        """
        try:
            from sentence_transformers import CrossEncoder
        except ImportError:
            raise ImportError(
                "sentence-transformers required for reranking. "
                "Install with: pip install sentence-transformers torch"
            )

        self.model_name = model
        self._model = CrossEncoder(
            model,
            device=device,
            trust_remote_code=True,
        )
        self.batch_size = batch_size

    async def rerank(self, query: str, documents: list[str]) -> list[float]:
        """Score query-document pairs for relevance.

        Args:
            query: Search query
            documents: List of documents to rerank

        Returns:
            List of relevance scores (0.0-1.0), same order as input documents
        """
        import asyncio

        # Create query-document pairs
        pairs = [[query, doc] for doc in documents]

        loop = asyncio.get_event_loop()
        scores = await loop.run_in_executor(
            None, lambda: self._model.predict(pairs, batch_size=self.batch_size)
        )

        # Normalize scores to 0-1 range if needed
        import numpy as np

        if isinstance(scores, np.ndarray):
            # Cross-encoders often output raw logits - normalize with sigmoid
            scores = 1 / (1 + np.exp(-scores))  # sigmoid

        return scores.tolist()

    async def rerank_with_scores(
        self, query: str, documents: list[str], top_k: int | None = None
    ) -> list[tuple[str, float]]:
        """Rerank documents and return sorted results.

        Args:
            query: Search query
            documents: List of documents to rerank
            top_k: Return only top k results (default: all)

        Returns:
            List of (document, score) tuples sorted by score descending
        """
        scores = await self.rerank(query, documents)

        # Sort by score descending
        sorted_results = sorted(zip(documents, scores), key=lambda x: x[1], reverse=True)

        if top_k:
            sorted_results = sorted_results[:top_k]

        return sorted_results

    @property
    def dimension(self) -> int:
        """Return model dimension (for compatibility)."""
        return self.MODELS.get(self.model_name, 1024)

