# Integration Testing Guide

This document describes the integration testing suite for Continuous-Claude-v3.

## Running Tests

### Run All Tests

```bash
cd /Users/grantray/Github/Continuous-Claude-v3/opc
uv run pytest tests/
```

### Run by Component

```bash
# Database tests
uv run pytest tests/test_database.py -v

# Wizard migration tests
uv run pytest tests/test_wizard_migration.py -v

# Validator/health check tests
uv run pytest tests/test_validator.py -v

# TLDR indexing tests
uv run pytest tests/test_tldr_indexing.py -v

# Integration test suite runner
uv run pytest tests/test_integration.py -v
```

### Run with Filters

```bash
# Run only integration tests
uv run pytest tests/test_integration.py -v -m integration

# Run only database tests
uv run pytest tests/ -v -m database

# Run with verbose output
uv run pytest tests/ -v --tb=short
```

### Integration Test Suite Runner

```bash
# Run all integration tests
python -m tests.test_integration

# Run specific component tests
python -m tests.test_integration --component database
python -m tests.test_integration --component wizard
python -m tests.test_integration --component validator
python -m tests.test_integration --component tldr

# List available tests
python -m tests.test_integration --list

# JSON output
python -m tests.test_integration --json
```

## Test Organization

### Test Files

| File | Description |
|------|-------------|
| `tests/conftest.py` | Pytest fixtures for database, mocks, temp directories |
| `tests/test_database.py` | PostgreSQL connection, schema, and memory service tests |
| `tests/test_wizard_migration.py` | Wizard update mode, hash comparison, sync operations |
| `tests/test_validator.py` | Health check providers and orchestrator tests |
| `tests/test_tldr_indexing.py` | Symbol index building and TLDR integration tests |
| `tests/test_integration.py` | Main integration test runner with filtering |

### Test Markers

Tests are tagged with markers for filtering:

- `@pytest.mark.database` - Database-related tests
- `@pytest.mark.wizard` - Wizard and migration tests
- `@pytest.mark.validator` - Health check and validation tests
- `@pytest.mark.tldr` - TLDR indexing and search tests
- `@pytest.mark.integration` - Full integration tests
- `@pytest.mark.slow` - Slow-running tests

## Fixtures

### Environment Fixtures

- `isolated_env` - Isolates environment variables for each test
- `event_loop` - Creates an event loop for async tests

### Directory Fixtures

- `temp_dir` - Creates a temporary directory (cleaned up after test)
- `temp_project_dir` - Creates a project directory structure
- `temp_claude_home` - Creates a mock ~/.claude directory

### Mock Fixtures

- `mock_subprocess` - Mocks subprocess module for git/docker operations
- `mock_async_subprocess` - Mocks asyncio subprocess for async operations
- `mock_git_repo` - Creates a temporary git repository
- `mock_typescript_hooks` - Creates a mock TypeScript hooks directory

### Database Fixtures

- `postgres_pool` - Creates PostgreSQL connection pool (skips if unavailable)
- `test_schema` - Creates test tables in the database
- `sqlite_db_path` - Creates SQLite database path
- `sqlite_connection` - Creates SQLite connection
- `initialized_sqlite_db` - Creates and initializes SQLite database

## Writing New Tests

### Basic Test Structure

```python
import pytest
from pathlib import Path

class TestFeature:
    """Tests for a specific feature."""

    def test_basic_functionality(self, temp_dir: Path) -> None:
        """Test basic functionality."""
        # Use temp_dir fixture
        test_file = temp_dir / "test.txt"
        test_file.write_text("hello")

        assert test_file.exists()

    @pytest.mark.asyncio
    async def test_async_functionality(self) -> None:
        """Test async functionality."""
        # Use async/await
        result = await some_async_function()
        assert result is not None
```

### Adding Fixtures

Add fixtures to `tests/conftest.py`:

```python
@pytest.fixture
def my_fixture() -> str:
    """My custom fixture."""
    return "fixture_value"
```

## CI/CD Integration

### GitHub Actions Example

```yaml
- name: Run Integration Tests
  run: |
    cd opc
    uv run pytest tests/test_integration.py -v --tb=short
  env:
    DATABASE_URL: postgresql://test:test@localhost:5432/test_db
```

### Running in CI

```bash
# Install test dependencies
cd opc
uv sync --extra dev

# Run tests
uv run pytest tests/ -v --tb=short
```

## Troubleshooting

### PostgreSQL Not Available

Tests will skip if PostgreSQL is not available. To run tests without PostgreSQL:

1. Tests with `@pytest.mark.skip` for PostgreSQL-specific functionality
2. SQLite fallback tests are available for basic functionality

### Async Test Issues

Ensure you have the `@pytest.mark.asyncio` decorator on async tests and `pytest-asyncio` installed.

### Test Timeouts

Some tests may timeout. Use `--timeout` flag:

```bash
uv run pytest tests/ --timeout=60
```

## Mock Strategy

1. **Database**: Use SQLite fallback when PostgreSQL unavailable
2. **Git**: Mock subprocess calls for git operations
3. **File System**: Use temporary directories for file operations
4. **Network**: Mock Docker container checks
5. **NPM**: Mock npm install/build commands
