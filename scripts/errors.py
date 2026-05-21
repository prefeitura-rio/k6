"""Shared exception types for the k6 scripts package."""


class ConfigError(Exception):
    """Raised when configuration is invalid or a required resource cannot be resolved."""
