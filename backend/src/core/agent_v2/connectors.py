"""Controlled extension boundary for Stage 5 external tools.

Connectors are registered by server code, never created from model-supplied URLs.
Every connector must still be wrapped as a ToolSpec and pass Policy checks.
"""

from __future__ import annotations

from typing import Any, Protocol


class ExternalConnector(Protocol):
    name: str
    allowed_actions: frozenset[str]

    async def invoke(self, action: str, payload: dict[str, Any]) -> dict[str, Any]:
        """Invoke one allow-listed action with schema-validated arguments."""


class ConnectorRegistry:
    def __init__(self) -> None:
        self._connectors: dict[str, ExternalConnector] = {}

    def register(self, connector: ExternalConnector) -> None:
        if not connector.allowed_actions:
            raise ValueError("外部连接器必须声明允许的动作")
        self._connectors[connector.name] = connector

    def get(self, name: str) -> ExternalConnector:
        if name not in self._connectors:
            raise KeyError(f"未配置外部连接器: {name}")
        return self._connectors[name]
