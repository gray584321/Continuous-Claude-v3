# Infrastructure

## Docker Containers

| Container | Status | Ports | Purpose |
|-----------|--------|-------|---------|
| `continuous-claude-postgres` | Up (healthy) | 5432 | Primary database with pgvector |
| `opc-redis` | Up | 6379 | Caching and session storage |

### PostgreSQL
- **Database:** `continuous_claude`
- **User:** `claude` / `claude_dev`
- **Host:** localhost:5432
- **Extensions:** pgvector for semantic search

### Redis
- **Host:** localhost:6379
- **Purpose:** Caching, session state

## Database Schema

Database schema is initialized via:
- `opc/docker/sandbox_runner.py` - Docker container initialization
- `opc/docker/Dockerfile.sandbox` - Docker build configuration

Note: There is no `init-db.sql` file - schema is created programmatically.

## Connection Details

```bash
# PostgreSQL
DATABASE_URL=postgresql://claude:claude_dev@localhost:5432/continuous_claude

# Redis
REDIS_URL=redis://localhost:6379
```
