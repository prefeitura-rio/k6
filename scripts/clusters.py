"""Resolve kubectl context names from clusters.json by prefix and environment."""

import json
from pathlib import Path
from sys import exit, stderr
from typing import cast

from .log import error

HERE = Path(__file__).parent.parent.resolve()
CLUSTERS_FILE = HERE / "files" / "clusters.json"

ClustersMap = dict[str, str | dict[str, str]]


def resolve_context(prefix: str, env: str) -> str:
    """Return the kubectl context for *prefix* and *env*, or exit with a clear error."""
    clusters = cast(ClustersMap, json.loads(CLUSTERS_FILE.read_text()))

    if prefix not in clusters:
        valid = ", ".join(sorted(clusters))
        error(f"Unknown prefix '{prefix}'. Valid prefixes: {valid}")
        exit(1)

    entry = clusters[prefix]

    if isinstance(entry, str):
        return entry

    if env not in entry:
        valid = ", ".join(sorted(entry))
        error(
            f"Unknown environment '{env}' for prefix '{prefix}'. Valid environments: {valid}"
        )
        exit(1)

    return entry[env]


if __name__ == "__main__":
    from sys import argv

    if len(argv) != 3:
        print("Usage: python3 -m scripts.clusters <prefix> <env>", file=stderr)
        exit(1)

    print(resolve_context(argv[1], argv[2]))
