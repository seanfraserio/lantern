"""Shared fixtures for Lantern Python SDK tests."""

import pytest
from unittest.mock import MagicMock

from lantern_ai.exporters.base import TraceExporter
from lantern_ai.tracer import LanternTracer
from lantern_ai.types import Trace


class MockExporter(TraceExporter):
    """In-memory exporter for testing."""

    def __init__(self) -> None:
        self.exported: list[list[Trace]] = []
        self.shutdown_called = False

    @property
    def exporter_type(self) -> str:
        return "mock"

    def export(self, traces: list[Trace]) -> None:
        self.exported.append(list(traces))

    async def export_async(self, traces: list[Trace]) -> None:
        self.exported.append(list(traces))

    def shutdown(self) -> None:
        self.shutdown_called = True

    async def shutdown_async(self) -> None:
        self.shutdown_called = True

    @property
    def all_traces(self) -> list[Trace]:
        return [t for batch in self.exported for t in batch]


@pytest.fixture
def mock_exporter() -> MockExporter:
    return MockExporter()


@pytest.fixture
def tracer(mock_exporter: MockExporter) -> LanternTracer:
    t = LanternTracer(
        service_name="test-service",
        agent_name="test-agent",
        exporter=mock_exporter,
        flush_interval=9999,  # prevent background timer from flushing
    )
    yield t
    # Cancel timer to avoid daemon threads leaking between tests
    if t._flush_timer is not None:
        t._flush_timer.cancel()
