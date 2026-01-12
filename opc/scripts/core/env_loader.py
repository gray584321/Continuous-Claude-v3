"""Environment variable loader for OPC scripts.

Loads .env file from the opc directory to make DATABASE_URL
and other environment variables available to all scripts.
"""

import os
from pathlib import Path


def load_env() -> None:
    """Load .env file from opc directory.

    This function reads the .env file and sets environment variables
    in the current process. Variables already set take precedence.
    """
    env_file = Path(__file__).parent.parent.parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            if "=" in line and not line.startswith("#"):
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip())


# Auto-load on import for convenience
load_env()
