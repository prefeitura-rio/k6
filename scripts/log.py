"""Shared logging utilities: ANSI-prefixed print functions, one per level."""

from sys import stderr

INFO = "\033[36m[→]\033[0m"
SUCCESS = "\033[32m[✓]\033[0m"
ERROR = "\033[31m[✗]\033[0m"
WARNING = "\033[33m[⚠]\033[0m"


def info(msg: str) -> None:
    """Print an informational message to stdout."""
    print(f"{INFO} {msg}")


def success(msg: str) -> None:
    """Print a success message to stdout."""
    print(f"{SUCCESS} {msg}")


def error(msg: str) -> None:
    """Print an error message to stderr."""
    print(f"{ERROR} {msg}", file=stderr)


def warning(msg: str) -> None:
    """Print a warning message to stdout."""
    print(f"{WARNING} {msg}")
