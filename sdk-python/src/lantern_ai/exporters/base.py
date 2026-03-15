"""Abstract base for trace exporters."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import List, TYPE_CHECKING

if TYPE_CHECKING:
    from ..types import Trace


class TraceExporter(ABC):
    """Interface that all exporters must implement."""

    @property
    @abstractmethod
    def exporter_type(self) -> str:
        """Short identifier for this exporter (e.g. ``"lantern"``, ``"console"``)."""
        ...

    @abstractmethod
    def export(self, traces: List["Trace"]) -> None:
        """Export a batch of traces synchronously."""
        ...

    def export_async(self, traces: List["Trace"]) -> "Any":
        """Export a batch of traces asynchronously.

        The default implementation delegates to the sync :meth:`export`.
        Subclasses may override with a true ``async def`` implementation.
        """
        import asyncio

        loop = asyncio.get_event_loop()
        return loop.run_in_executor(None, self.export, traces)

    def shutdown(self) -> None:
        """Release any resources held by the exporter."""

    async def shutdown_async(self) -> None:
        """Async variant of :meth:`shutdown`."""
        self.shutdown()
