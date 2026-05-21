"""Resolve kubectl context names from clusters.json by prefix and environment."""

import json
from pathlib import Path
from sys import stderr

from .errors import ConfigError
from .log import error

HERE = Path(__file__).parent.parent.resolve()
CLUSTERS_FILE = HERE / "files" / "clusters.json"


def resolve_context(prefix: str, env: str) -> str:
    """Return the kubectl context for *prefix* and *env*.

    Raises `ConfigError` when the prefix or environment is not found.
    """
    raw = json.loads(CLUSTERS_FILE.read_text())
    if not isinstance(raw, dict):
        raise ConfigError(f"'{CLUSTERS_FILE}' must be a JSON object at the top level")

    if prefix not in raw:
        valid = ", ".join(sorted(raw))
        raise ConfigError(f"Unknown prefix '{prefix}'. Valid prefixes: {valid}")

    entry = raw[prefix]

    if isinstance(entry, str):
        return entry

    if not isinstance(entry, dict):
        raise ConfigError(f"Entry for prefix '{prefix}' must be a string or object, got {type(entry).__name__}")

    if env not in entry:
        valid = ", ".join(sorted(entry))
        raise ConfigError(
            f"Unknown environment '{env}' for prefix '{prefix}'. Valid environments: {valid}"
        )

    context = entry[env]
    if not isinstance(context, str):
        raise ConfigError(f"Context for '{prefix}/{env}' must be a string, got {type(context).__name__}")

    return context


if __name__ == "__main__":
    from sys import argv, exit

    if len(argv) != 3:
        print("Usage: python3 -m scripts.clusters <prefix> <env>", file=stderr)
        exit(1)

    try:
        print(resolve_context(argv[1], argv[2]))
    except ConfigError as e:
        error(str(e))
        exit(1)
