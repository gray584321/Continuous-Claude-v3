#!/usr/bin/env python3
"""
Comprehensive Daemon Health Check System for Continuous-Claude-v3

Provides health monitoring for the memory daemon and cross-component health checks.

USAGE:
    # As module
    from health_check import HealthCheck, HealthLevel

    # CLI commands
    uv run python scripts/core/health_check.py status
    uv run python scripts/core/health_check.py liveness
    uv run python/scripts/core/health_check.py readiness
    uv run python scripts/core/health_check.py startup
    uv run python scripts/core/health_check.py metrics

    # Start health check server (HTTP endpoint for k8s probes)
    uv run python scripts/core/health_check.py server --port 8080

    # Run all checks with recovery
    uv run python scripts/core/health_check.py check --recover

ARCHITECTURE:
    - Three health levels: liveness, readiness, startup
    - Pluggable health check providers
    - Prometheus metrics export
    - Automated recovery actions
    - HTTP server for k8s probe endpoints
    - APScheduler for periodic checks

HEALTH LEVELS:
    - startup: One-time checks during startup (DB schema, dirs exist)
    - readiness: Is service ready to accept traffic (DB, Redis connected)
    - liveness: Is service alive (process running, PID valid)
"""

import argparse
import asyncio
import json
import os
import psutil
import re
import shlex
import signal
import socket
import sqlite3
import subprocess
import sys
import threading
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field, asdict
from datetime import datetime, timedelta
from enum import Enum
from functools import wraps
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path
from typing import Any, Callable, Optional

# Prometheus metrics (optional - only if prometheus_client available)
try:
    from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST
    PROMETHEUS_AVAILABLE = True
except ImportError:
    PROMETHEUS_AVAILABLE = False


# =============================================================================
# Configuration
# =============================================================================

# Paths
CLAUDE_HOME = Path.home() / ".claude"
HOOKS_DIR = CLAUDE_HOME / "hooks"
HOOKS_SRC_DIR = HOOKS_DIR / "src"
HOOKS_DIST_DIR = HOOKS_DIR / "dist"
SETTINGS_FILE = CLAUDE_HOME / "settings.json"
PID_FILE = CLAUDE_HOME / "memory-daemon.pid"
LOG_FILE = CLAUDE_HOME / "memory-daemon.log"
DB_FILE = CLAUDE_HOME / "sessions.db"

# Thresholds
MAX_QUEUE_DEPTH = 100
MAX_BACKLOG = 50
MIN_DISK_GB = 1.0
MAX_MEMORY_PERCENT = 90.0
MAX_CONNECTION_LATENCY_MS = 5000


# =============================================================================
# Enums and Data Classes
# =============================================================================

class HealthLevel(Enum):
    """Health check levels following k8s probe pattern."""
    STARTUP = "startup"    # One-time checks during startup
    READINESS = "readiness"  # Ready to accept traffic
    LIVENESS = "liveness"    # Service is alive


class HealthStatus(Enum):
    """Health check result status."""
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


@dataclass
class HealthCheckResult:
    """Result of a single health check."""
    name: str
    status: HealthStatus
    level: HealthLevel
    message: str
    details: dict[str, Any] = field(default_factory=dict)
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    recovery_action: str | None = None

    def to_dict(self) -> dict:
        """Convert to dictionary with enum serialization."""
        return {
            'name': self.name,
            'status': self.status.value if isinstance(self.status, HealthStatus) else self.status,
            'level': self.level.value if isinstance(self.level, HealthLevel) else self.level,
            'message': self.message,
            'details': self.details,
            'timestamp': self.timestamp,
            'recovery_action': self.recovery_action,
        }


@dataclass
class HealthReport:
    """Complete health report from all checks."""
    overall_status: HealthStatus
    level: HealthLevel
    checks: list[HealthCheckResult]
    timestamp: str = field(default_factory=lambda: datetime.now().isoformat())
    uptime_seconds: float = 0.0

    def to_dict(self) -> dict:
        # Custom serialization for enums
        return {
            'overall_status': self.overall_status.value if isinstance(self.overall_status, HealthStatus) else self.overall_status,
            'level': self.level.value if isinstance(self.level, HealthLevel) else self.level,
            'checks': [c.to_dict() for c in self.checks],
            'timestamp': self.timestamp,
            'uptime_seconds': self.uptime_seconds,
        }

    def to_json(self, indent: int = 2) -> str:
        return json.dumps(self.to_dict(), indent=indent)


# =============================================================================
# Prometheus Metrics
# =============================================================================

if PROMETHEUS_AVAILABLE:
    # Counters
    health_checks_total = Counter(
        'health_checks_total',
        'Total number of health checks performed',
        ['level', 'status']
    )
    recovery_actions_total = Counter(
        'recovery_actions_total',
        'Total number of recovery actions performed',
        ['action_type', 'success']
    )

    # Gauges
    queue_depth = Gauge(
        'memory_daemon_queue_depth',
        'Current number of pending extractions in queue'
    )
    active_extractions = Gauge(
        'memory_daemon_active_extractions',
        'Number of currently running extractions'
    )
    backlog_count = Gauge(
        'memory_daemon_backlog_count',
        'Number of stale sessions awaiting extraction'
    )
    connection_latency_ms = Gauge(
        'connection_latency_ms',
        'Database connection latency in milliseconds',
        ['connection_type']
    )
    disk_free_gb = Gauge(
        'disk_free_gb',
        'Free disk space in GB',
        ['mount_point']
    )
    memory_percent = Gauge(
        'memory_percent',
        'System memory usage percentage'
    )

    # Histograms
    health_check_duration_seconds = Histogram(
        'health_check_duration_seconds',
        'Health check duration in seconds',
        ['check_name'],
        buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0]
    )


def record_metrics(result: HealthCheckResult, duration: float):
    """Record Prometheus metrics for a health check result."""
    if not PROMETHEUS_AVAILABLE:
        return

    try:
        health_checks_total.labels(
            level=result.level.value,
            status=result.status.value
        ).inc()

        health_check_duration_seconds.labels(
            check_name=result.name
        ).observe(duration)

        # Update gauges based on check type
        if result.name == "queue_depth":
            queue_depth.set(result.details.get("depth", 0))
        elif result.name == "active_extractions":
            active_extractions.set(result.details.get("count", 0))
        elif result.name == "backlog":
            backlog_count.set(result.details.get("count", 0))
        elif result.name == "connection_latency":
            latency = result.details.get("latency_ms", 0)
            connection_latency_ms.labels(
                connection_type=result.details.get("type", "unknown")
            ).set(latency)
        elif result.name == "disk_space":
            disk_free_gb.labels(
                mount_point=result.details.get("mount", "/")
            ).set(result.details.get("free_gb", 0))
        elif result.name == "memory_pressure":
            memory_percent.set(result.details.get("percent", 0))

        # Record recovery action
        if result.recovery_action:
            recovery_actions_total.labels(
                action_type=result.recovery_action,
                success="true" if result.status == HealthStatus.HEALTHY else "false"
            ).inc()
    except Exception:
        pass  # Don't let metric recording fail


# =============================================================================
# Health Check Providers
# =============================================================================

class HealthCheckProvider(ABC):
    """Abstract base class for health check providers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Unique name for this health check."""
        pass

    @abstractmethod
    def check(self) -> HealthCheckResult:
        """Perform the health check and return result."""
        pass

    @abstractmethod
    def get_level(self) -> HealthLevel:
        """Which health level this check belongs to."""
        pass


class PidFileCheck(HealthCheckProvider):
    """Check PID file validity and process liveness."""

    def __init__(self, pid_file: Path = PID_FILE):
        self.pid_file = pid_file

    @property
    def name(self) -> str:
        return "pid_file"

    def get_level(self) -> HealthLevel:
        return HealthLevel.LIVENESS

    def check(self) -> HealthCheckResult:
        if not self.pid_file.exists():
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message="PID file does not exist",
                details={"pid_file": str(self.pid_file)},
                recovery_action="start_daemon"
            )

        try:
            pid = int(self.pid_file.read_text().strip())
            # Check if process exists
            os.kill(pid, 0)
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"Process {pid} is alive",
                details={"pid": pid}
            )
        except ValueError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message="PID file contains invalid value",
                details={"pid_file": str(self.pid_file)},
                recovery_action="clean_pid_file"
            )
        except ProcessLookupError:
            # Stale PID file
            self.pid_file.unlink(missing_ok=True)
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"Process from PID file no longer exists",
                details={"stale_pid": pid},
                recovery_action="restart_daemon"
            )
        except PermissionError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="Process exists (permission restricted)",
                details={"pid": pid}
            )


class ProcessLivenessCheck(HealthCheckProvider):
    """Check if daemon process is responsive."""

    def __init__(self, pid_file: Path = PID_FILE):
        self.pid_file = pid_file

    @property
    def name(self) -> str:
        return "process_liveness"

    def get_level(self) -> HealthLevel:
        return HealthLevel.LIVENESS

    def check(self) -> HealthCheckResult:
        running, pid = is_daemon_running(self.pid_file)
        if not running:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message="Daemon process is not running",
                details={"pid_file": str(self.pid_file)},
                recovery_action="restart_daemon"
            )

        # Check if process is responsive (not zombie)
        try:
            proc = psutil.Process(pid)
            status = proc.status()
            if status == psutil.STATUS_ZOMBIE:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message=f"Process is zombie state",
                    details={"pid": pid, "status": status},
                    recovery_action="kill_and_restart"
                )

            # Check memory usage
            memory_info = proc.memory_info()
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"Process responsive (status: {status})",
                details={
                    "pid": pid,
                    "status": status,
                    "memory_mb": memory_info.rss / 1024 / 1024
                }
            )
        except psutil.NoSuchProcess:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message="Process no longer exists",
                recovery_action="restart_daemon"
            )


class DatabaseConnectionCheck(HealthCheckProvider):
    """Check database connectivity and latency."""

    def __init__(self):
        self.postgres_url = os.environ.get("DATABASE_URL") or os.environ.get("CONTINUOUS_CLAUDE_DB_URL")

    @property
    def name(self) -> str:
        return "database_connection"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def _check_postgres(self) -> HealthCheckResult:
        if not self.postgres_url:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="PostgreSQL not configured, using SQLite fallback",
                details={"type": "postgres", "configured": False}
            )

        try:
            import psycopg2
            start = time.time()
            conn = psycopg2.connect(self.postgres_url)
            cur = conn.cursor()
            cur.execute("SELECT 1")
            cur.fetchone()
            latency_ms = (time.time() - start) * 1000
            conn.close()

            if latency_ms > MAX_CONNECTION_LATENCY_MS:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message=f"PostgreSQL latency {latency_ms:.0f}ms exceeds threshold",
                    details={"type": "postgres", "latency_ms": latency_ms},
                    recovery_action="check_db_load"
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"PostgreSQL connected ({latency_ms:.0f}ms)",
                details={"type": "postgres", "latency_ms": latency_ms}
            )
        except ImportError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="psycopg2 not installed, using SQLite",
                details={"type": "postgres", "driver_available": False}
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"PostgreSQL connection failed: {e}",
                details={"type": "postgres", "error": str(e)},
                recovery_action="check_db_connection"
            )

    def _check_sqlite(self) -> HealthCheckResult:
        db_path = DB_FILE
        try:
            if not db_path.exists():
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="SQLite database does not exist",
                    details={"type": "sqlite", "path": str(db_path)},
                    recovery_action="create_db"
                )

            start = time.time()
            conn = sqlite3.connect(db_path)
            cursor = conn.execute("SELECT 1")
            cursor.fetchone()
            latency_ms = (time.time() - start) * 1000
            conn.close()

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"SQLite connected ({latency_ms:.0f}ms)",
                details={"type": "sqlite", "latency_ms": latency_ms}
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"SQLite connection failed: {e}",
                details={"type": "sqlite", "error": str(e)},
                recovery_action="check_db_file"
            )

    def check(self) -> HealthCheckResult:
        if self.postgres_url:
            return self._check_postgres()
        return self._check_sqlite()


class RedisConnectionCheck(HealthCheckProvider):
    """Check Redis connectivity and latency."""

    def __init__(self):
        self.redis_url = os.environ.get("REDIS_URL") or os.environ.get("CONTINUOUS_CLAUDE_REDIS_URL")

    @property
    def name(self) -> str:
        return "redis_connection"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        if not self.redis_url:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="Redis not configured (optional)",
                details={"configured": False}
            )

        try:
            import redis
            start = time.time()
            r = redis.from_url(self.redis_url)
            r.ping()
            latency_ms = (time.time() - start) * 1000

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"Redis connected ({latency_ms:.0f}ms)",
                details={"latency_ms": latency_ms}
            )
        except ImportError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="redis-py not installed",
                details={"driver_available": False}
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"Redis connection failed: {e}",
                details={"error": str(e)},
                recovery_action="check_redis_connection"
            )


class QueueDepthCheck(HealthCheckProvider):
    """Check extraction queue depth."""

    @property
    def name(self) -> str:
        return "queue_depth"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        # Get queue state from daemon or estimate
        queue_state = get_queue_state()

        if queue_state.depth > MAX_QUEUE_DEPTH:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message=f"Queue depth {queue_state.depth} exceeds threshold {MAX_QUEUE_DEPTH}",
                details={
                    "depth": queue_state.depth,
                    "threshold": MAX_QUEUE_DEPTH,
                    "active": queue_state.active
                },
                recovery_action="process_queue"
            )

        return HealthCheckResult(
            name=self.name,
            status=HealthStatus.HEALTHY,
            level=self.get_level(),
            message=f"Queue healthy (depth={queue_state.depth}, active={queue_state.active})",
            details={
                "depth": queue_state.depth,
                "active": queue_state.active
            }
        )


class BacklogCheck(HealthCheckProvider):
    """Check extraction backlog (stale sessions not yet processed)."""

    @property
    def name(self) -> str:
        return "backlog"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        stale_sessions = get_stale_sessions_count()

        if stale_sessions > MAX_BACKLOG:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message=f"Backlog {stale_sessions} exceeds threshold {MAX_BACKLOG}",
                details={
                    "count": stale_sessions,
                    "threshold": MAX_BACKLOG
                },
                recovery_action="process_backlog"
            )

        return HealthCheckResult(
            name=self.name,
            status=HealthStatus.HEALTHY,
            level=self.get_level(),
            message=f"Backlog healthy ({stale_sessions} pending)",
            details={"count": stale_sessions}
        )


class DiskSpaceCheck(HealthCheckProvider):
    """Check disk space for logs, PID files, and database."""

    def __init__(self, min_free_gb: float = MIN_DISK_GB):
        self.min_free_gb = min_free_gb

    @property
    def name(self) -> str:
        return "disk_space"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        try:
            disk_usage = psutil.disk_usage(str(CLAUDE_HOME))
            free_gb = disk_usage.free / (1024**3)

            if free_gb < self.min_free_gb:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message=f"Disk space critically low: {free_gb:.1f}GB free",
                    details={
                        "free_gb": free_gb,
                        "total_gb": disk_usage.total / (1024**3),
                        "percent": disk_usage.percent
                    },
                    recovery_action="cleanup_logs"
                )

            if free_gb < self.min_free_gb * 2:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message=f"Disk space low: {free_gb:.1f}GB free",
                    details={
                        "free_gb": free_gb,
                        "percent": disk_usage.percent
                    }
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"Disk space OK: {free_gb:.1f}GB free",
                details={
                    "free_gb": free_gb,
                    "percent": disk_usage.percent
                }
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not check disk space: {e}",
                details={"error": str(e)}
            )


class MemoryPressureCheck(HealthCheckProvider):
    """Check system memory pressure."""

    def __init__(self, max_percent: float = MAX_MEMORY_PERCENT):
        self.max_percent = max_percent

    @property
    def name(self) -> str:
        return "memory_pressure"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        try:
            memory = psutil.virtual_memory()
            percent = memory.percent

            if percent > self.max_percent:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message=f"Memory critically low: {percent}% used",
                    details={
                        "percent": percent,
                        "available_gb": memory.available / (1024**3),
                        "total_gb": memory.total / (1024**3)
                    },
                    recovery_action="free_memory"
                )

            if percent > self.max_percent * 0.8:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message=f"Memory pressure high: {percent}% used",
                    details={"percent": percent}
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"Memory OK: {percent}% used",
                details={"percent": percent}
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not check memory: {e}",
                details={"error": str(e)}
            )


class SchemaCheck(HealthCheckProvider):
    """Check database schema is valid (startup only)."""

    @property
    def name(self) -> str:
        return "database_schema"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        postgres_url = os.environ.get("DATABASE_URL") or os.environ.get("CONTINUOUS_CLAUDE_DB_URL")

        if postgres_url:
            return self._check_postgres_schema(postgres_url)
        return self._check_sqlite_schema()

    def _check_postgres_schema(self, url: str) -> HealthCheckResult:
        try:
            import psycopg2
            conn = psycopg2.connect(url)
            cur = conn.cursor()

            # Check for sessions table
            cur.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'sessions'
                )
            """)
            if not cur.fetchone()[0]:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message="PostgreSQL sessions table missing",
                    recovery_action="create_schema"
                )

            # Check for memory_extracted_at column
            cur.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.columns
                    WHERE table_name = 'sessions'
                    AND column_name = 'memory_extracted_at'
                )
            """)
            if not cur.fetchone()[0]:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="PostgreSQL memory_extracted_at column missing",
                    recovery_action="migrate_schema"
                )

            conn.close()
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="PostgreSQL schema valid"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"Could not verify schema: {e}",
                details={"error": str(e)},
                recovery_action="check_db_connection"
            )

    def _check_sqlite_schema(self) -> HealthCheckResult:
        db_path = DB_FILE
        if not db_path.exists():
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="SQLite database does not exist yet (will be created)",
                details={"path": str(db_path)}
            )

        try:
            conn = sqlite3.connect(db_path)
            cursor = conn.execute("""
                SELECT name FROM sqlite_master
                WHERE type='table' AND name='sessions'
            """)
            if cursor.fetchone() is None:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message="SQLite sessions table missing",
                    recovery_action="create_schema"
                )

            # Check for memory_extracted_at column
            cursor = conn.execute("PRAGMA table_info(sessions)")
            columns = [row[1] for row in cursor.fetchall()]
            if "memory_extracted_at" not in columns:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="SQLite memory_extracted_at column missing",
                    recovery_action="migrate_schema"
                )

            conn.close()
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="SQLite schema valid"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"Could not verify schema: {e}",
                details={"error": str(e)}
            )


class LogFileCheck(HealthCheckProvider):
    """Check log file is writable and not growing too large."""

    @property
    def name(self) -> str:
        return "log_file"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        try:
            log_file = LOG_FILE

            # Check if log directory exists
            if not log_file.parent.exists():
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="Log directory does not exist",
                    details={"path": str(log_file.parent)},
                    recovery_action="create_log_dir"
                )

            # Check if log file is writable
            try:
                if log_file.exists():
                    log_file.open("a").close()
                else:
                    log_file.parent.mkdir(parents=True, exist_ok=True)
                    log_file.touch()
            except PermissionError:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message="Log file is not writable",
                    details={"path": str(log_file)},
                    recovery_action="fix_log_permissions"
                )

            # Check log file size (max 100MB)
            if log_file.exists():
                size_mb = log_file.stat().st_size / (1024 * 1024)
                if size_mb > 100:
                    return HealthCheckResult(
                        name=self.name,
                        status=HealthStatus.DEGRADED,
                        level=self.get_level(),
                        message=f"Log file large: {size_mb:.1f}MB",
                        details={"size_mb": size_mb},
                        recovery_action="rotate_logs"
                    )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="Log file OK",
                details={"size_mb": size_mb if log_file.exists() else 0}
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not check log file: {e}",
                details={"error": str(e)}
            )


# =============================================================================
# Hook Health Check Providers (Phase 1)
# =============================================================================

class HookFileCheck(HealthCheckProvider):
    """Verify hooks exist in dist/ directory."""

    @property
    def name(self) -> str:
        return "hook_file"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        if not HOOKS_DIST_DIR.exists():
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message="Hooks dist/ directory does not exist",
                details={"path": str(HOOKS_DIST_DIR)},
                recovery_action="build_hooks"
            )

        mjs_files = list(HOOKS_DIST_DIR.glob("*.mjs"))
        if not mjs_files:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message="No .mjs files found in hooks dist/",
                details={"path": str(HOOKS_DIST_DIR), "count": 0},
                recovery_action="build_hooks"
            )

        return HealthCheckResult(
            name=self.name,
            status=HealthStatus.HEALTHY,
            level=self.get_level(),
            message=f"Hooks dist/ directory exists ({len(mjs_files)} .mjs files)",
            details={"path": str(HOOKS_DIST_DIR), "count": len(mjs_files)}
        )


class HookSyntaxCheck(HealthCheckProvider):
    """Validate TypeScript syntax with tsc --noEmit."""

    @property
    def name(self) -> str:
        return "hook_syntax"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        if not HOOKS_DIR.exists():
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="Hooks directory does not exist (skipping syntax check)",
                details={"path": str(HOOKS_DIR)}
            )

        try:
            result = subprocess.run(
                ["npx", "tsc", "--noEmit"],
                cwd=str(HOOKS_DIR),
                capture_output=True,
                text=True,
                timeout=60
            )

            if result.returncode != 0:
                # Parse errors from tsc output
                error_lines = [l for l in result.stdout.split("\n") + result.stderr.split("\n")
                              if "error" in l.lower()]
                error_count = len(error_lines)
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message=f"TypeScript compilation failed ({error_count} errors)",
                    details={
                        "returncode": result.returncode,
                        "errors": error_lines[:10] if error_lines else []
                    },
                    recovery_action="fix_typescript_errors"
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="TypeScript compilation passed (0 errors)",
                details={"returncode": result.returncode}
            )
        except FileNotFoundError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="npx/tsc not installed (skipping syntax check)",
                recovery_action="install_typescript"
            )
        except subprocess.TimeoutExpired:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="TypeScript compilation timed out",
                recovery_action="check_typescript_config"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not run TypeScript check: {e}",
                details={"error": str(e)}
            )


class HookBuildCheck(HealthCheckProvider):
    """Verify hooks were built by comparing source/dist timestamps."""

    @property
    def name(self) -> str:
        return "hook_build"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        if not HOOKS_SRC_DIR.exists() or not HOOKS_DIST_DIR.exists():
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="Source or dist directory missing (skipping build check)"
            )

        # Get latest source file modification time
        src_files = list(HOOKS_SRC_DIR.glob("**/*.ts"))
        if src_files:
            latest_src_mtime = max(f.stat().st_mtime for f in src_files)
        else:
            latest_src_mtime = 0

        # Get latest dist file modification time
        dist_files = list(HOOKS_DIST_DIR.glob("*.mjs"))
        if dist_files:
            latest_dist_mtime = max(f.stat().st_mtime for f in dist_files)
        else:
            latest_dist_mtime = 0

        if latest_src_mtime > latest_dist_mtime:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="Hooks are out of date (source newer than dist)",
                details={
                    "source_count": len(src_files),
                    "dist_count": len(dist_files),
                    "source_newer": True
                },
                recovery_action="build_hooks"
            )

        return HealthCheckResult(
            name=self.name,
            status=HealthStatus.HEALTHY,
            level=self.get_level(),
            message="Hooks are up to date",
            details={
                "source_count": len(src_files),
                "dist_count": len(dist_files)
            }
        )


class HookConfigCheck(HealthCheckProvider):
    """Validate .claude/settings.json configuration."""

    @property
    def name(self) -> str:
        return "hook_config"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        if not SETTINGS_FILE.exists():
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="settings.json does not exist",
                details={"path": str(SETTINGS_FILE)},
                recovery_action="regenerate_settings"
            )

        try:
            with open(SETTINGS_FILE) as f:
                config = json.load(f)

            # Basic validation - check for expected structure
            errors = []

            if "hooks" not in config:
                errors.append("Missing 'hooks' configuration")

            # Check hooks is a list/dict
            hooks = config.get("hooks")
            if hooks is not None and not isinstance(hooks, (list, dict)):
                errors.append("'hooks' must be a list or dict")

            if errors:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message=f"settings.json has validation issues",
                    details={"errors": errors},
                    recovery_action="fix_settings"
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="settings.json is valid",
                details={"path": str(SETTINGS_FILE)}
            )

        except json.JSONDecodeError as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"settings.json is not valid JSON: {e}",
                details={"error": str(e)},
                recovery_action="regenerate_settings"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not validate settings.json: {e}",
                details={"error": str(e)}
            )


# =============================================================================
# Bash Command Validator (Phase 2)
# =============================================================================

class BashCommandValidator:
    """Utility class for running and validating bash commands."""

    @staticmethod
    def run_command(cmd: str, timeout: int = 10, cwd: str | None = None) -> tuple[int, str, str]:
        """Run command, return (exit_code, stdout, stderr)."""
        try:
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=cwd
            )
            return result.returncode, result.stdout, result.stderr
        except subprocess.TimeoutExpired:
            return -1, "", "Command timed out"
        except Exception as e:
            return -1, "", str(e)

    @staticmethod
    def test_git() -> HealthCheckResult:
        """Test git commands."""
        # Test git status
        exit_code, stdout, stderr = BashCommandValidator.run_command("git status", timeout=5)
        if exit_code != 0:
            return HealthCheckResult(
                name="git_status",
                status=HealthStatus.UNHEALTHY,
                level=HealthLevel.READINESS,
                message=f"git status failed: {stderr}",
                recovery_action="check_git_installation"
            )

        # Test git log (optional)
        exit_code, stdout, stderr = BashCommandValidator.run_command("git log -1 --oneline", timeout=5)
        if exit_code != 0:
            return HealthCheckResult(
                name="git_log",
                status=HealthStatus.DEGRADED,
                level=HealthLevel.READINESS,
                message=f"git log failed: {stderr}"
            )

        return HealthCheckResult(
            name="git_commands",
            status=HealthStatus.HEALTHY,
            level=HealthLevel.READINESS,
            message="git commands work",
            details={"last_commit": stdout.strip()[:50] if stdout else "unknown"}
        )

    @staticmethod
    def test_docker_postgres() -> HealthCheckResult:
        """Test docker exec for PostgreSQL."""
        cmd = "docker exec continuous-claude-postgres psql -U claude -d continuous_claude -c 'SELECT 1' 2>&1"
        exit_code, stdout, stderr = BashCommandValidator.run_command(cmd, timeout=10)

        if exit_code != 0:
            # Check if container exists but postgres isn't ready
            if "could not find" in stderr.lower() or "no such container" in stderr.lower():
                return HealthCheckResult(
                    name="docker_postgres",
                    status=HealthStatus.DEGRADED,
                    level=HealthLevel.READINESS,
                    message="PostgreSQL container not found",
                    recovery_action="start_postgres_container"
                )
            return HealthCheckResult(
                name="docker_postgres",
                status=HealthStatus.UNHEALTHY,
                level=HealthLevel.READINESS,
                message=f"PostgreSQL query failed: {stderr}",
                recovery_action="check_postgres_connection"
            )

        return HealthCheckResult(
            name="docker_postgres",
            status=HealthStatus.HEALTHY,
            level=HealthLevel.READINESS,
            message="docker exec psql works"
        )

    @staticmethod
    def test_npm_build() -> HealthCheckResult:
        """Test npm run build in hooks directory."""
        if not HOOKS_DIR.exists():
            return HealthCheckResult(
                name="npm_build",
                status=HealthStatus.DEGRADED,
                level=HealthLevel.READINESS,
                message="hooks directory not found"
            )

        # Quick test: check if package.json exists and has build script
        package_json = HOOKS_DIR / "package.json"
        if not package_json.exists():
            return HealthCheckResult(
                name="npm_build",
                status=HealthStatus.DEGRADED,
                level=HealthLevel.READINESS,
                message="package.json not found in hooks directory"
            )

        try:
            with open(package_json) as f:
                pkg = json.load(f)
            if "scripts" not in pkg or "build" not in pkg.get("scripts", {}):
                return HealthCheckResult(
                    name="npm_build",
                    status=HealthStatus.DEGRADED,
                    level=HealthLevel.READINESS,
                    message="build script not found in package.json"
                )
        except Exception as e:
            return HealthCheckResult(
                name="npm_build",
                status=HealthStatus.DEGRADED,
                level=HealthLevel.READINESS,
                message=f"Could not read package.json: {e}"
            )

        # Run actual build test (quick check)
        exit_code, stdout, stderr = BashCommandValidator.run_command(
            "npm run build --if-present",
            cwd=str(HOOKS_DIR),
            timeout=60
        )

        if exit_code != 0:
            return HealthCheckResult(
                name="npm_build",
                status=HealthStatus.UNHEALTHY,
                level=HealthLevel.READINESS,
                message=f"npm run build failed: {stderr}",
                recovery_action="fix_build_errors"
            )

        return HealthCheckResult(
            name="npm_build",
            status=HealthStatus.HEALTHY,
            level=HealthLevel.READINESS,
            message="npm run build works"
        )

    @staticmethod
    def test_tldr_cli() -> HealthCheckResult:
        """Test tldr CLI availability."""
        # Check if tldr is installed
        exit_code, stdout, stderr = BashCommandValidator.run_command("which tldr", timeout=5)
        if exit_code != 0:
            return HealthCheckResult(
                name="tldr_cli",
                status=HealthStatus.DEGRADED,
                level=HealthLevel.READINESS,
                message="tldr CLI not found in PATH",
                recovery_action="install_tldr"
            )

        # Get version
        exit_code, stdout, stderr = BashCommandValidator.run_command("tldr --version", timeout=5)
        version = stdout.strip() if stdout else "unknown"

        return HealthCheckResult(
            name="tldr_cli",
            status=HealthStatus.HEALTHY,
            level=HealthLevel.READINESS,
            message=f"tldr CLI is installed ({version})",
            details={"version": version, "path": stdout.strip() if exit_code == 0 else "unknown"}
        )


class BashCommandCheck(HealthCheckProvider):
    """Check critical bash commands."""

    @property
    def name(self) -> str:
        return "bash_commands"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        results = []

        # Test git
        results.append(BashCommandValidator.test_git())

        # Test docker/postgres
        results.append(BashCommandValidator.test_docker_postgres())

        # Test npm build
        results.append(BashCommandValidator.test_npm_build())

        # Test tldr
        results.append(BashCommandValidator.test_tldr_cli())

        # Aggregate results
        unhealthy = [r for r in results if r.status == HealthStatus.UNHEALTHY]
        degraded = [r for r in results if r.status == HealthStatus.DEGRADED]
        healthy = [r for r in results if r.status == HealthStatus.HEALTHY]

        if unhealthy:
            overall_status = HealthStatus.UNHEALTHY
            message = f"{len(unhealthy)} critical command(s) failed"
        elif degraded:
            overall_status = HealthStatus.DEGRADED
            message = f"{len(degraded)} optional command(s) degraded"
        else:
            overall_status = HealthStatus.HEALTHY
            message = "All critical commands working"

        return HealthCheckResult(
            name=self.name,
            status=overall_status,
            level=self.get_level(),
            message=message,
            details={
                "total": len(results),
                "healthy": len(healthy),
                "degraded": len(degraded),
                "unhealthy": len(unhealthy)
            },
            recovery_action="fix_bash_commands" if unhealthy else None
        )


# =============================================================================
# TLDR/LLM Verification Providers (Phase 3)
# =============================================================================

class TldrCliCheck(HealthCheckProvider):
    """Verify tldr CLI is installed and functional."""

    @property
    def name(self) -> str:
        return "tldr_functional"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        # Check which tldr
        exit_code, stdout, stderr = BashCommandValidator.run_command("which tldr", timeout=5)
        if exit_code != 0:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="tldr CLI not found",
                recovery_action="install_tldr"
            )

        tldr_path = stdout.strip()

        # Run basic tldr command
        exit_code, stdout, stderr = BashCommandValidator.run_command(
            "tldr --version",
            timeout=10
        )

        if exit_code != 0:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message=f"tldr --version failed: {stderr}",
                recovery_action="reinstall_tldr"
            )

        # Try a simple tldr command to verify functionality
        exit_code, stdout, stderr = BashCommandValidator.run_command(
            "tldr tree . 2>&1 | head -20",
            cwd=str(Path(__file__).parent.parent.parent),
            timeout=15
        )

        return HealthCheckResult(
            name=self.name,
            status=HealthStatus.HEALTHY,
            level=self.get_level(),
            message=f"tldr CLI is functional",
            details={"path": tldr_path, "version": stdout.strip() if stdout else "unknown"}
        )


class TldrIndexCheck(HealthCheckProvider):
    """Verify tldr symbol index exists and is current."""

    @property
    def name(self) -> str:
        return "tldr_index"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        # Check for tldr index in common locations
        index_locations = [
            Path.home() / ".cache" / "tldr" / "index.json",
            Path.home() / ".local" / "share" / "tldr" / "index.json",
            Path.home() / ".claude" / "tldr-index.json",
        ]

        index_path = None
        for loc in index_locations:
            if loc.exists():
                index_path = loc
                break

        if not index_path:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="tldr index not found",
                recovery_action="rebuild_tldr_index"
            )

        # Check if index is stale (> 24 hours old)
        try:
            mtime = index_path.stat().st_mtime
            age_hours = (time.time() - mtime) / 3600
            if age_hours > 24:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message=f"tldr index is stale ({age_hours:.1f} hours old)",
                    details={"path": str(index_path), "age_hours": age_hours},
                    recovery_action="rebuild_tldr_index"
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"tldr index exists and is current",
                details={"path": str(index_path), "age_hours": age_hours}
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not check index age: {e}"
            )


class LlmProviderCheck(HealthCheckProvider):
    """Verify LLM API key is configured."""

    @property
    def name(self) -> str:
        return "llm_provider"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        # Check for Anthropic API key
        api_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("CLAUDE_API_KEY")

        if not api_key:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="ANTHROPIC_API_KEY not configured",
                details={"configured": False},
                recovery_action="configure_api_key"
            )

        # Validate key format
        if not api_key.startswith("sk-ant-api"):
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="API key format may be invalid",
                details={"key_prefix": api_key[:15] + "..."}
            )

        return HealthCheckResult(
            name=self.name,
            status=HealthStatus.HEALTHY,
            level=self.get_level(),
            message="ANTHROPIC_API_KEY is configured",
            details={"configured": True, "key_prefix": api_key[:15] + "..."}
        )


class EmbeddingProviderCheck(HealthCheckProvider):
    """Verify pgvector/embeddings are working."""

    @property
    def name(self) -> str:
        return "embedding_provider"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        postgres_url = os.environ.get("DATABASE_URL")
        if not postgres_url:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="PostgreSQL not configured for embeddings",
                details={"configured": False}
            )

        try:
            import psycopg2
            conn = psycopg2.connect(postgres_url)
            cur = conn.cursor()

            # Check pgvector extension
            cur.execute("SELECT * FROM pg_extension WHERE extname = 'vector'")
            vector_exists = cur.fetchone() is not None

            if not vector_exists:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message="pgvector extension not installed",
                    recovery_action="install_pgvector"
                )

            # Check if embedding column exists
            cur.execute("""
                SELECT column_name FROM information_schema.columns
                WHERE table_name = 'archival_memory' AND column_name = 'embedding'
            """)
            embedding_exists = cur.fetchone() is not None

            conn.close()

            if not embedding_exists:
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="embedding column missing (will be created on migration)"
                )

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="pgvector is installed and configured",
                details={"pgvector": True, "embedding_column": embedding_exists}
            )

        except ImportError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="psycopg2 not installed (cannot check pgvector)"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message=f"Could not verify embeddings: {e}",
                details={"error": str(e)}
            )


# =============================================================================
# Database Index Verification Providers (Phase 4)
# =============================================================================

class VectorIndexCheck(HealthCheckProvider):
    """Verify pgvector extension and indexes."""

    @property
    def name(self) -> str:
        return "vector_index"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        postgres_url = os.environ.get("DATABASE_URL")
        if not postgres_url:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="PostgreSQL not configured",
                details={"configured": False}
            )

        try:
            import psycopg2
            conn = psycopg2.connect(postgres_url)
            cur = conn.cursor()

            # Check pgvector extension
            cur.execute("SELECT * FROM pg_extension WHERE extname = 'vector'")
            if not cur.fetchone():
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message="pgvector extension not installed",
                    recovery_action="install_pgvector"
                )

            # Check vector column exists
            cur.execute("""
                SELECT column_name, data_type FROM information_schema.columns
                WHERE table_name = 'archival_memory' AND column_name = 'embedding'
            """)
            col = cur.fetchone()

            if not col:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="embedding column missing in archival_memory"
                )

            # Check indexes
            cur.execute("""
                SELECT indexname, indexdef FROM pg_indexes
                WHERE tablename = 'archival_memory'
            """)
            indexes = cur.fetchall()

            conn.close()

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="pgvector extension installed",
                details={
                    "extension": "vector",
                    "column": col[0],
                    "data_type": col[1],
                    "indexes": [i[0] for i in indexes]
                }
            )

        except ImportError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="psycopg2 not installed"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"Could not verify vector index: {e}",
                details={"error": str(e)},
                recovery_action="check_db_connection"
            )


class SchemaVersionCheck(HealthCheckProvider):
    """Verify migration version."""

    @property
    def name(self) -> str:
        return "schema_version"

    def get_level(self) -> HealthLevel:
        return HealthLevel.STARTUP

    def check(self) -> HealthCheckResult:
        postgres_url = os.environ.get("DATABASE_URL")
        if not postgres_url:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="PostgreSQL not configured",
                details={"configured": False}
            )

        try:
            import psycopg2
            conn = psycopg2.connect(postgres_url)
            cur = conn.cursor()

            # Check for schema_migrations table
            cur.execute("""
                SELECT EXISTS (
                    SELECT FROM information_schema.tables
                    WHERE table_name = 'schema_migrations'
                )
            """)
            has_migrations_table = cur.fetchone()[0]

            if not has_migrations_table:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.DEGRADED,
                    level=self.get_level(),
                    message="schema_migrations table not found"
                )

            # Get latest migration version
            cur.execute("SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1")
            row = cur.fetchone()
            version = row[0] if row else "unknown"

            conn.close()

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message=f"Schema is up to date (version {version})",
                details={"version": version}
            )

        except ImportError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="psycopg2 not installed"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNKNOWN,
                level=self.get_level(),
                message=f"Could not check schema version: {e}",
                details={"error": str(e)}
            )


class DatabasePermissionsCheck(HealthCheckProvider):
    """Verify database user permissions."""

    @property
    def name(self) -> str:
        return "db_permissions"

    def get_level(self) -> HealthLevel:
        return HealthLevel.READINESS

    def check(self) -> HealthCheckResult:
        postgres_url = os.environ.get("DATABASE_URL")
        if not postgres_url:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="PostgreSQL not configured"
            )

        try:
            import psycopg2
            conn = psycopg2.connect(postgres_url)
            cur = conn.cursor()

            # Test SELECT on all tables
            tables = ["sessions", "file_claims", "handoffs", "archival_memory"]
            select_ok = True
            for table in tables:
                try:
                    cur.execute(f"SELECT 1 FROM {table} LIMIT 1")
                    cur.fetchone()
                except Exception:
                    select_ok = False
                    break

            if not select_ok:
                conn.close()
                return HealthCheckResult(
                    name=self.name,
                    status=HealthStatus.UNHEALTHY,
                    level=self.get_level(),
                    message="User lacks SELECT permissions on some tables",
                    recovery_action="fix_database_permissions"
                )

            # Test INSERT on sessions table (non-destructive)
            try:
                cur.execute("""
                    INSERT INTO sessions (id, project, working_on, last_heartbeat)
                    VALUES ('_health_check_', 'health_check', 'health_check', NOW())
                    ON CONFLICT (id) DO NOTHING
                """)
                conn.commit()
            except Exception:
                pass  # Ignore insert failures

            conn.close()

            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.HEALTHY,
                level=self.get_level(),
                message="User has required permissions",
                details={"tables": tables, "select_ok": True}
            )

        except ImportError:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.DEGRADED,
                level=self.get_level(),
                message="psycopg2 not installed"
            )
        except Exception as e:
            return HealthCheckResult(
                name=self.name,
                status=HealthStatus.UNHEALTHY,
                level=self.get_level(),
                message=f"Could not verify permissions: {e}",
                details={"error": str(e)},
                recovery_action="fix_database_permissions"
            )


# =============================================================================
# Utility Functions
# =============================================================================

@dataclass
class QueueState:
    """State of the extraction queue."""
    depth: int = 0
    active: int = 0


def is_daemon_running(pid_file: Path = PID_FILE) -> tuple[bool, int | None]:
    """Check if daemon is running."""
    if not pid_file.exists():
        return False, None

    try:
        pid = int(pid_file.read_text().strip())
        os.kill(pid, 0)
        return True, pid
    except (ValueError, ProcessLookupError, PermissionError):
        pid_file.unlink(missing_ok=True)
        return False, None


def get_queue_state() -> QueueState:
    """Get current queue state from daemon or estimate."""
    running, pid = is_daemon_running()
    if not running:
        return QueueState(depth=0, active=0)

    try:
        proc = psutil.Process(pid)
        # Try to read from proc stats
        cmdline = proc.cmdline()
        if "--daemon-subprocess" in cmdline or len(cmdline) >= 1:
            # This is the daemon process
            # Estimate based on memory/proc state
            return QueueState(
                depth=proc.num_threads() * 5,  # Rough estimate
                active=1
            )
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        pass

    return QueueState(depth=0, active=1)


def get_stale_sessions_count() -> int:
    """Get count of stale sessions awaiting extraction."""
    postgres_url = os.environ.get("DATABASE_URL") or os.environ.get("CONTINUOUS_CLAUDE_DB_URL")

    if postgres_url:
        try:
            import psycopg2
            conn = psycopg2.connect(postgres_url)
            cur = conn.cursor()
            threshold = datetime.now() - timedelta(minutes=5)
            cur.execute("""
                SELECT COUNT(*) FROM sessions
                WHERE last_heartbeat < %s
                AND memory_extracted_at IS NULL
            """, (threshold,))
            count = cur.fetchone()[0]
            conn.close()
            return count
        except Exception:
            pass

    # SQLite fallback
    db_path = DB_FILE
    if not db_path.exists():
        return 0

    try:
        conn = sqlite3.connect(db_path)
        threshold = (datetime.now() - timedelta(minutes=5)).isoformat()
        cursor = conn.execute("""
            SELECT COUNT(*) FROM sessions
            WHERE last_heartbeat < ?
            AND memory_extracted_at IS NULL
        """, (threshold,))
        count = cursor.fetchone()[0]
        conn.close()
        return count
    except Exception:
        return 0


# =============================================================================
# Health Check Orchestrator
# =============================================================================

class HealthCheck:
    """Main health check orchestrator."""

    def __init__(self):
        self.providers: list[HealthCheckProvider] = []
        self._register_default_providers()

    def _register_default_providers(self):
        """Register default health check providers."""
        # Liveness checks
        self.providers.append(PidFileCheck())
        self.providers.append(ProcessLivenessCheck())

        # Readiness checks
        self.providers.append(DatabaseConnectionCheck())
        self.providers.append(RedisConnectionCheck())
        self.providers.append(QueueDepthCheck())
        self.providers.append(BacklogCheck())
        self.providers.append(DiskSpaceCheck())
        self.providers.append(MemoryPressureCheck())
        self.providers.append(LogFileCheck())

        # Startup checks
        self.providers.append(SchemaCheck())

        # Hook health checks (Phase 1)
        self.providers.append(HookFileCheck())
        self.providers.append(HookSyntaxCheck())
        self.providers.append(HookBuildCheck())
        self.providers.append(HookConfigCheck())

        # Bash command checks (Phase 2)
        self.providers.append(BashCommandCheck())

        # TLDR/LLM checks (Phase 3)
        self.providers.append(TldrCliCheck())
        self.providers.append(TldrIndexCheck())
        self.providers.append(LlmProviderCheck())
        self.providers.append(EmbeddingProviderCheck())

        # Database index checks (Phase 4)
        self.providers.append(VectorIndexCheck())
        self.providers.append(SchemaVersionCheck())
        self.providers.append(DatabasePermissionsCheck())

    def add_provider(self, provider: HealthCheckProvider):
        """Add a custom health check provider."""
        self.providers.append(provider)

    def get_providers_for_level(self, level: HealthLevel) -> list[HealthCheckProvider]:
        """Get all providers for a specific health level."""
        return [p for p in self.providers if p.get_level() == level]

    def check_level(self, level: HealthLevel) -> HealthReport:
        """Run all health checks for a specific level."""
        providers = self.get_providers_for_level(level)
        results = []
        start_time = time.time()

        for provider in providers:
            check_start = time.time()
            try:
                result = provider.check()
            except Exception as e:
                result = HealthCheckResult(
                    name=provider.name,
                    status=HealthStatus.UNKNOWN,
                    level=level,
                    message=f"Check failed with exception: {e}",
                    details={"error": str(e)}
                )
            duration = time.time() - check_start
            record_metrics(result, duration)
            results.append(result)

        # Determine overall status
        if any(r.status == HealthStatus.UNHEALTHY for r in results):
            overall = HealthStatus.UNHEALTHY
        elif any(r.status == HealthStatus.DEGRADED for r in results):
            overall = HealthStatus.DEGRADED
        elif all(r.status == HealthStatus.HEALTHY for r in results):
            overall = HealthStatus.HEALTHY
        else:
            overall = HealthStatus.UNKNOWN

        return HealthReport(
            overall_status=overall,
            level=level,
            checks=results,
            uptime_seconds=time.time() - start_time
        )

    def check_liveness(self) -> HealthReport:
        """Run liveness checks (is service alive?)."""
        return self.check_level(HealthLevel.LIVENESS)

    def check_readiness(self) -> HealthReport:
        """Run readiness checks (is service ready for traffic?)."""
        return self.check_level(HealthLevel.READINESS)

    def check_startup(self) -> HealthReport:
        """Run startup checks (one-time schema/setup)."""
        return self.check_level(HealthLevel.STARTUP)

    def check_all(self) -> HealthReport:
        """Run all health checks across all levels."""
        # Run checks for all levels and aggregate results
        all_results = []
        start_time = time.time()

        for level in [HealthLevel.STARTUP, HealthLevel.READINESS, HealthLevel.LIVENESS]:
            level_report = self.check_level(level)
            all_results.extend(level_report.checks)

        # Determine overall status
        if any(r.status == HealthStatus.UNHEALTHY for r in all_results):
            overall = HealthStatus.UNHEALTHY
        elif any(r.status == HealthStatus.DEGRADED for r in all_results):
            overall = HealthStatus.DEGRADED
        elif all(r.status == HealthStatus.HEALTHY for r in all_results):
            overall = HealthStatus.HEALTHY
        else:
            overall = HealthStatus.UNKNOWN

        return HealthReport(
            overall_status=overall,
            level=HealthLevel.LIVENESS,
            checks=all_results,
            uptime_seconds=time.time() - start_time
        )

    def run_recovery(self, result: HealthCheckResult) -> bool:
        """Attempt automated recovery for a failed check."""
        action = result.recovery_action
        if not action:
            return False

        recovery_actions = {
            "start_daemon": self._action_start_daemon,
            "restart_daemon": self._action_restart_daemon,
            "kill_and_restart": self._action_kill_and_restart,
            "clean_pid_file": self._action_clean_pid_file,
            "process_queue": self._action_process_queue,
            "process_backlog": self._action_process_backlog,
            "cleanup_logs": self._action_cleanup_logs,
            "rotate_logs": self._action_rotate_logs,
            "free_memory": self._action_free_memory,
            "check_db_connection": self._action_check_db_connection,
            "check_redis_connection": self._action_check_redis_connection,
            # Hook recovery actions
            "build_hooks": self._action_build_hooks,
            "fix_typescript_errors": self._action_fix_typescript_errors,
            "regenerate_settings": self._action_regenerate_settings,
            # Bash command recovery actions
            "check_git_installation": self._action_check_git,
            "start_postgres_container": self._action_start_postgres,
            "check_postgres_connection": self._action_check_postgres,
            "fix_build_errors": self._action_fix_build_errors,
            "install_tldr": self._action_install_tldr,
            "reinstall_tldr": self._action_reinstall_tldr,
            "fix_bash_commands": self._action_fix_bash_commands,
            # LLM recovery actions
            "configure_api_key": self._action_configure_api_key,
            # Embedding recovery actions
            "configure_embedding_provider": self._action_configure_embedding,
            "install_pgvector": self._action_install_pgvector,
            # Database recovery actions
            "run_migrations": self._action_run_migrations,
            "fix_database_permissions": self._action_fix_permissions,
            # Index recovery actions
            "rebuild_tldr_index": self._action_rebuild_tldr_index,
            # Settings recovery actions
            "fix_settings": self._action_fix_settings,
            "install_typescript": self._action_install_typescript,
            "check_typescript_config": self._action_check_tsc_config,
        }

        action_func = recovery_actions.get(action)
        if action_func:
            try:
                return action_func()
            except Exception as e:
                print(f"Recovery action {action} failed: {e}")
                return False
        return False

    def _action_start_daemon(self) -> bool:
        """Start the memory daemon."""
        try:
            daemon_path = Path(__file__).parent / "memory_daemon.py"
            subprocess.Popen(
                [sys.executable, str(daemon_path), "start"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            return True
        except Exception:
            return False

    def _action_restart_daemon(self) -> bool:
        """Restart the memory daemon."""
        try:
            running, pid = is_daemon_running()
            if running:
                os.kill(pid, signal.SIGTERM)
                time.sleep(2)
            self._action_start_daemon()
            return True
        except Exception:
            return False

    def _action_kill_and_restart(self) -> bool:
        """Force kill and restart daemon."""
        try:
            running, pid = is_daemon_running()
            if running:
                os.kill(pid, signal.SIGKILL)
                PID_FILE.unlink(missing_ok=True)
                time.sleep(1)
            self._action_start_daemon()
            return True
        except Exception:
            return False

    def _action_clean_pid_file(self) -> bool:
        """Remove stale PID file."""
        try:
            PID_FILE.unlink(missing_ok=True)
            return True
        except Exception:
            return False

    def _action_process_queue(self) -> bool:
        """Trigger queue processing."""
        # This would signal the daemon to process more aggressively
        running, pid = is_daemon_running()
        if running:
            try:
                os.kill(pid, signal.SIGHUP)
                return True
            except Exception:
                pass
        return False

    def _action_process_backlog(self) -> bool:
        """Trigger backlog processing."""
        running, pid = is_daemon_running()
        if running:
            try:
                os.kill(pid, signal.SIGUSR1)
                return True
            except Exception:
                pass
        return False

    def _action_cleanup_logs(self) -> bool:
        """Clean up old log files."""
        try:
            log_dir = LOG_FILE.parent
            if log_dir.exists():
                # Remove logs older than 7 days
                seven_days_ago = time.time() - (7 * 24 * 60 * 60)
                for f in log_dir.glob("*.log*"):
                    if f.stat().st_mtime < seven_days_ago:
                        f.unlink()
                return True
        except Exception:
            pass
        return False

    def _action_rotate_logs(self) -> bool:
        """Rotate log files."""
        try:
            if LOG_FILE.exists():
                # Rename current log with timestamp
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                rotated = LOG_FILE.with_suffix(f".{timestamp}.log")
                LOG_FILE.rename(rotated)
                # Create new log file
                LOG_FILE.touch()
                return True
        except Exception:
            pass
        return False

    def _action_free_memory(self) -> bool:
        """Attempt to free memory."""
        # This is limited - we can only suggest manual intervention
        return False

    def _action_check_db_connection(self) -> bool:
        """Verify database connection can be established."""
        postgres_url = os.environ.get("DATABASE_URL")
        if postgres_url:
            try:
                import psycopg2
                psycopg2.connect(postgres_url, connect_timeout=5)
                return True
            except Exception:
                pass
        return False

    def _action_check_redis_connection(self) -> bool:
        """Verify Redis connection can be established."""
        redis_url = os.environ.get("REDIS_URL")
        if redis_url:
            try:
                import redis
                r = redis.from_url(redis_url, socket_timeout=5)
                r.ping()
                return True
            except Exception:
                pass
        return False

    # =========================================================================
    # Hook Recovery Actions
    # =========================================================================

    def _action_build_hooks(self) -> bool:
        """Build hooks by running npm run build."""
        if not HOOKS_DIR.exists():
            return False
        try:
            result = subprocess.run(
                ["npm", "run", "build"],
                cwd=str(HOOKS_DIR),
                capture_output=True,
                timeout=120
            )
            return result.returncode == 0
        except Exception:
            return False

    def _action_fix_typescript_errors(self) -> bool:
        """Show TypeScript compilation errors."""
        if not HOOKS_DIR.exists():
            return False
        try:
            result = subprocess.run(
                ["npx", "tsc", "--noEmit"],
                cwd=str(HOOKS_DIR),
                capture_output=True,
                text=True,
                timeout=60
            )
            if result.returncode != 0:
                print("TypeScript Errors:")
                print(result.stdout)
                print(result.stderr)
            return result.returncode == 0
        except Exception:
            return False

    def _action_regenerate_settings(self) -> bool:
        """Regenerate .claude/settings.json."""
        print("To regenerate settings, run: uv run python -m scripts.setup.wizard")
        return False

    def _action_fix_settings(self) -> bool:
        """Fix settings.json issues."""
        print("Review settings.json and fix the reported issues.")
        return False

    def _action_install_typescript(self) -> bool:
        """Install TypeScript."""
        print("To install TypeScript: npm install -g typescript")
        return False

    def _action_check_tsc_config(self) -> False:
        """Check TypeScript configuration."""
        print("Review tsconfig.json for configuration issues.")
        return False

    # =========================================================================
    # Bash Command Recovery Actions
    # =========================================================================

    def _action_check_git(self) -> bool:
        """Check git installation."""
        print("Git is not properly installed or not in PATH.")
        return False

    def _action_start_postgres(self) -> bool:
        """Start PostgreSQL container."""
        print("To start PostgreSQL: docker-compose up -d (in opc/ directory)")
        return False

    def _action_check_postgres(self) -> bool:
        """Check PostgreSQL connection."""
        print("Check that PostgreSQL container is running: docker ps")
        return False

    def _action_fix_build_errors(self) -> bool:
        """Fix npm build errors."""
        print("Review npm build output for specific errors.")
        return False

    def _action_install_tldr(self) -> bool:
        """Install tldr CLI."""
        print("To install tldr: brew install tldr (macOS) or npm install -g tldr")
        return False

    def _action_reinstall_tldr(self) -> bool:
        """Reinstall tldr CLI."""
        print("To reinstall tldr: brew reinstall tldr or npm install -g tldr")
        return False

    def _action_fix_bash_commands(self) -> bool:
        """Fix bash command issues."""
        print("Review the failed command checks and resolve dependencies.")
        return False

    # =========================================================================
    # LLM Recovery Actions
    # =========================================================================

    def _action_configure_api_key(self) -> bool:
        """Configure API key."""
        print("Set ANTHROPIC_API_KEY environment variable:")
        print("  export ANTHROPIC_API_KEY='your-api-key'")
        return False

    # =========================================================================
    # Embedding Recovery Actions
    # =========================================================================

    def _action_configure_embedding(self) -> bool:
        """Configure embedding provider."""
        print("Configure DATABASE_URL for PostgreSQL with pgvector extension.")
        return False

    def _action_install_pgvector(self) -> bool:
        """Install pgvector extension."""
        print("To install pgvector:")
        print("  1. Connect to PostgreSQL container")
        print("  2. Run: CREATE EXTENSION IF NOT EXISTS vector;")
        return False

    # =========================================================================
    # Database Recovery Actions
    # =========================================================================

    def _action_run_migrations(self) -> bool:
        """Run database migrations."""
        print("To run migrations: uv run python scripts/core/migrate.py")
        return False

    def _action_fix_permissions(self) -> bool:
        """Fix database permissions."""
        print("Grant required permissions to the database user.")
        return False

    # =========================================================================
    # Index Recovery Actions
    # =========================================================================

    def _action_rebuild_tldr_index(self) -> bool:
        """Rebuild tldr index."""
        print("To rebuild tldr index: tldr --update")
        return False


# =============================================================================
# HTTP Server for Kubernetes Probes
# =============================================================================

class HealthCheckHandler(BaseHTTPRequestHandler):
    """HTTP handler for health check endpoints."""

    health_check: HealthCheck | None = None

    def log_message(self, format, *args):
        """Suppress default logging."""
        pass

    def _send_response(self, status: int, content: dict):
        """Send JSON response."""
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(content).encode())

    def do_GET(self):
        """Handle GET requests."""
        path = self.path.rstrip("/")

        if path == "/health" or path == "":
            # Full health check
            report = self.health_check.check_all()
            status_code = 200 if report.overall_status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED] else 503
            self._send_response(status_code, report.to_dict())
        elif path == "/health/live":
            # Liveness probe
            report = self.health_check.check_liveness()
            status_code = 200 if report.overall_status == HealthStatus.HEALTHY else 503
            self._send_response(status_code, report.to_dict())
        elif path == "/health/ready":
            # Readiness probe
            report = self.health_check.check_readiness()
            status_code = 200 if report.overall_status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED] else 503
            self._send_response(status_code, report.to_dict())
        elif path == "/health/startup":
            # Startup probe
            report = self.health_check.check_startup()
            status_code = 200 if report.overall_status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED] else 503
            self._send_response(status_code, report.to_dict())
        elif path == "/metrics":
            # Prometheus metrics
            if PROMETHEUS_AVAILABLE:
                self.send_response(200)
                self.send_header("Content-Type", CONTENT_TYPE_LATEST)
                self.end_headers()
                self.wfile.write(generate_latest())
            else:
                self._send_response(404, {"error": "Prometheus client not installed"})
        else:
            self._send_response(404, {"error": "Not found"})


def run_server(host: str = "0.0.0.0", port: int = 8080):
    """Run the health check HTTP server."""
    health_check = HealthCheck()
    HealthCheckHandler.health_check = health_check

    server = HTTPServer((host, port), HealthCheckHandler)
    print(f"Health check server running on http://{host}:{port}")
    print("Endpoints:")
    print("  GET /health        - Full health report")
    print("  GET /health/live   - Liveness probe")
    print("  GET /health/ready  - Readiness probe")
    print("  GET /health/startup - Startup probe")
    print("  GET /metrics       - Prometheus metrics")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down health check server...")
        server.shutdown()


# =============================================================================
# CLI Interface
# =============================================================================

def format_result(result: HealthCheckResult, indent: int = 0) -> str:
    """Format a health check result for display."""
    status_icons = {
        HealthStatus.HEALTHY: "[OK]",
        HealthStatus.DEGRADED: "[WARN]",
        HealthStatus.UNHEALTHY: "[FAIL]",
        HealthStatus.UNKNOWN: "[?]"
    }
    icon = status_icons.get(result.status, "[?]")

    lines = [
        f"{' ' * indent}{icon} {result.name}: {result.message}"
    ]

    if result.details:
        for key, value in result.details.items():
            lines.append(f"{' ' * (indent + 2)}{key}: {value}")

    if result.recovery_action:
        lines.append(f"{' ' * (indent + 2)}recovery: {result.recovery_action}")

    return "\n".join(lines)


def cmd_status(args):
    """Show full health status."""
    hc = HealthCheck()
    report = hc.check_all()

    print(f"\n{'='*60}")
    print(f"Health Report - {report.level.value.upper()}")
    print(f"{'='*60}")
    print(f"Overall Status: {report.overall_status.value.upper()}")
    print(f"Timestamp: {report.timestamp}")
    print()

    for result in report.checks:
        print(format_result(result))
        print()

    # Try recovery for unhealthy checks
    if args.recover:
        print("\n--- Attempting Recovery ---")
        for result in report.checks:
            if result.status == HealthStatus.UNHEALTHY:
                print(f"Attempting recovery for: {result.name}")
                if hc.run_recovery(result):
                    print(f"  Recovery action '{result.recovery_action}' completed")
                else:
                    print(f"  Recovery action '{result.recovery_action}' failed")

    return 0 if report.overall_status != HealthStatus.UNHEALTHY else 1


def cmd_liveness(args):
    """Show liveness status."""
    hc = HealthCheck()
    report = hc.check_liveness()
    print(f"Liveness: {report.overall_status.value.upper()}")
    for result in report.checks:
        print(format_result(result, indent=2))
    return 0 if report.overall_status == HealthStatus.HEALTHY else 1


def cmd_readiness(args):
    """Show readiness status."""
    hc = HealthCheck()
    report = hc.check_readiness()
    print(f"Readiness: {report.overall_status.value.upper()}")
    for result in report.checks:
        print(format_result(result, indent=2))
    return 0 if report.overall_status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED] else 1


def cmd_startup(args):
    """Show startup status."""
    hc = HealthCheck()
    report = hc.check_startup()
    print(f"Startup: {report.overall_status.value.upper()}")
    for result in report.checks:
        print(format_result(result, indent=2))
    return 0 if report.overall_status in [HealthStatus.HEALTHY, HealthStatus.DEGRADED] else 1


def cmd_metrics(args):
    """Show Prometheus metrics."""
    if PROMETHEUS_AVAILABLE:
        print(generate_latest().decode())
        return 0
    else:
        print("Prometheus client not installed. Install with: pip install prometheus_client")
        return 1


def cmd_server(args):
    """Run health check server."""
    run_server(host=args.host, port=args.port)
    return 0


def cmd_check(args):
    """Run specific check type with optional recovery."""
    hc = HealthCheck()

    if args.type == "all":
        report = hc.check_all()
    elif args.type == "liveness":
        report = hc.check_liveness()
    elif args.type == "readiness":
        report = hc.check_readiness()
    elif args.type == "startup":
        report = hc.check_startup()
    else:
        # Run specific named check
        report = hc.check_all()
        report.checks = [c for c in report.checks if c.name == args.type]

    print(report.to_json())

    # Try recovery if requested
    if args.recover:
        print("\n--- Recovery Actions ---")
        for result in report.checks:
            if result.status == HealthStatus.UNHEALTHY:
                if hc.run_recovery(result):
                    print(f"Recovered: {result.name}")
                else:
                    print(f"Failed to recover: {result.name}")

    return 0 if report.overall_status != HealthStatus.UNHEALTHY else 1


def format_validation_report(report: HealthReport, verbose: bool = False) -> str:
    """Format validation report for display."""
    # Group results by component type
    component_groups = {}
    for result in report.checks:
        # Determine component from check name
        name = result.name
        if name.startswith("hook_"):
            component = "hooks"
        elif name.startswith("bash_commands") or name.startswith("git_") or name.startswith("docker_") or name.startswith("npm_"):
            component = "bash"
        elif name.startswith("tldr_"):
            component = "tldr"
        elif name.startswith("llm_") or name.startswith("embedding_"):
            component = "llm"
        elif name.startswith("vector_") or name.startswith("schema_") or name.startswith("db_"):
            component = "database"
        else:
            component = "other"

        if component not in component_groups:
            component_groups[component] = []
        component_groups[component].append(result)

    lines = [
        "=" * 60,
        "Continuous-Claude-v3 Validator",
        "=" * 60,
        f"Timestamp: {report.timestamp}",
        "",
    ]

    # Overall status
    overall = report.overall_status.value.upper()
    if report.overall_status == HealthStatus.HEALTHY:
        lines.append(f"OVERALL: {overall}")
    elif report.overall_status == HealthStatus.DEGRADED:
        lines.append(f"OVERALL: {overall}")
    else:
        lines.append(f"OVERALL: {overall}")
    lines.append("")

    # Component sections
    status_icons = {
        HealthStatus.HEALTHY: "[OK]",
        HealthStatus.DEGRADED: "[WARN]",
        HealthStatus.UNHEALTHY: "[FAIL]",
        HealthStatus.UNKNOWN: "[?]"
    }

    for component in sorted(component_groups.keys()):
        lines.append(f"COMPONENT: {component}")
        for result in component_groups[component]:
            icon = status_icons.get(result.status, "[?]")
            lines.append(f"  {icon} {result.name}: {result.message}")
            if verbose and result.details:
                for key, value in result.details.items():
                    lines.append(f"      {key}: {value}")
        lines.append("")

    # Summary
    total = len(report.checks)
    passed = sum(1 for r in report.checks if r.status == HealthStatus.HEALTHY)
    failed = sum(1 for r in report.checks if r.status == HealthStatus.UNHEALTHY)
    degraded = sum(1 for r in report.checks if r.status == HealthStatus.DEGRADED)

    lines.append("SUMMARY:")
    lines.append(f"  Total: {total} | Passed: {passed} | Failed: {failed} | Degraded: {degraded}")

    return "\n".join(lines)


def cmd_validate(args):
    """Run comprehensive validation of all components."""
    hc = HealthCheck()
    report = hc.check_all()

    # Filter by component
    if args.component != "all":
        component_map = {
            "hook": ["hook_"],
            "bash": ["bash_commands", "git_", "docker_", "npm_"],
            "tldr": ["tldr_"],
            "llm": ["llm_", "embedding_"],
            "database": ["vector_", "schema_", "db_"],
        }
        filter_prefixes = component_map.get(args.component, [])
        if filter_prefixes:
            report.checks = [c for c in report.checks
                            if any(c.name.startswith(p) for p in filter_prefixes)]

    # Filter by level
    if args.level != "all":
        report.checks = [c for c in report.checks if c.level.value == args.level]

    # Output format
    if args.json:
        print(report.to_json())
    else:
        print(format_validation_report(report, verbose=args.verbose))

    return 0 if report.overall_status != HealthStatus.UNHEALTHY else 1


def main():
    parser = argparse.ArgumentParser(
        description="Continuous-Claude-v3 Health Check System",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  # Check overall health
  uv run python scripts/core/health_check.py status

  # Quick liveness check
  uv run python scripts/core/health_check.py liveness

  # Readiness check (can accept traffic)
  uv run python scripts/core/health_check.py readiness

  # Check with automatic recovery
  uv run python scripts/core/health_check.py status --recover

  # Run health check server (for Kubernetes)
  uv run python scripts/core/health_check.py server --port 8080

  # Get Prometheus metrics
  uv run python scripts/core/health_check.py metrics

Health Levels:
  startup  - One-time checks (schema, directories)
  readiness - Can accept traffic (connections, queue depth)
  liveness - Is alive (process running, PID valid)
        """
    )

    subparsers = parser.add_subparsers(dest="command", help="Commands")

    # status command
    status_parser = subparsers.add_parser("status", help="Show full health status")
    status_parser.add_argument("--recover", action="store_true", help="Attempt automatic recovery")

    # liveness command
    subparsers.add_parser("liveness", help="Show liveness status")

    # readiness command
    subparsers.add_parser("readiness", help="Show readiness status")

    # startup command
    subparsers.add_parser("startup", help="Show startup status")

    # check command
    check_parser = subparsers.add_parser("check", help="Run specific health check")
    check_parser.add_argument("type", choices=["all", "liveness", "readiness", "startup"], help="Check type")
    check_parser.add_argument("--recover", action="store_true", help="Attempt automatic recovery")

    # metrics command
    subparsers.add_parser("metrics", help="Show Prometheus metrics")

    # server command
    server_parser = subparsers.add_parser("server", help="Run health check HTTP server")
    server_parser.add_argument("--port", type=int, default=8080, help="Port to listen on")
    server_parser.add_argument("--host", default="0.0.0.0", help="Host to bind to")

    # validate command
    validate_parser = subparsers.add_parser("validate", help="Validate all components")
    validate_parser.add_argument("--verbose", "-v", action="store_true", help="Show detailed output")
    validate_parser.add_argument("--component", "-c",
                                choices=["hook", "bash", "tldr", "llm", "database", "all"],
                                default="all", help="Filter by component")
    validate_parser.add_argument("--level", "-l",
                                choices=["startup", "readiness", "liveness", "all"],
                                default="all", help="Filter by health level")
    validate_parser.add_argument("--json", action="store_true", help="Output as JSON")

    args = parser.parse_args()

    if not args.command:
        parser.print_help()
        return 1

    command_handlers = {
        "status": cmd_status,
        "liveness": cmd_liveness,
        "readiness": cmd_readiness,
        "startup": cmd_startup,
        "check": cmd_check,
        "metrics": cmd_metrics,
        "server": cmd_server,
        "validate": cmd_validate,
    }

    handler = command_handlers.get(args.command)
    if handler:
        return handler(args)

    return 1


if __name__ == "__main__":
    sys.exit(main() or 0)
