"""ConsoleExporter -- prints traces to stdout for development / debugging."""

from __future__ import annotations

import sys
from typing import List

from .base import TraceExporter
from ..types import Trace


class ConsoleExporter(TraceExporter):
    """Exports traces to stdout with optional per-span detail.

    Parameters
    ----------
    verbose:
        When ``True``, print individual span details (default ``False``).
    use_color:
        When ``True`` (default), use ANSI color codes in output.
    """

    def __init__(self, *, verbose: bool = False, use_color: bool = True) -> None:
        self._verbose = verbose
        self._use_color = use_color and hasattr(sys.stdout, "isatty") and sys.stdout.isatty()

    @property
    def exporter_type(self) -> str:
        return "console"

    # -- Helpers -------------------------------------------------------------

    def _c(self, code: str, text: str) -> str:
        if not self._use_color:
            return text
        return f"\033[{code}m{text}\033[0m"

    def _status_color(self, status: str) -> str:
        colors = {"success": "32", "error": "31", "running": "33"}
        code = colors.get(status, "0")
        return self._c(code, status)

    # -- Export --------------------------------------------------------------

    def export(self, traces: List[Trace]) -> None:
        for trace in traces:
            status = self._status_color(trace.status)
            header = self._c("1", f"[lantern] Trace {trace.id}")
            print(f"{header} | {trace.agent_name} | {status}")
            duration = f"{trace.duration_ms:.0f}" if trace.duration_ms is not None else "running"
            print(f"  Duration: {duration}ms")
            print(f"  Tokens: {trace.total_input_tokens} in / {trace.total_output_tokens} out")
            print(f"  Cost: ${trace.estimated_cost_usd:.6f}")
            print(f"  Spans: {len(trace.spans)}")

            if self._verbose:
                for span in trace.spans:
                    span_id = span.id[:8]
                    dur = f"{span.duration_ms:.0f}" if span.duration_ms else "0"
                    span_type = self._c("36", f"[{span.type}]")
                    print(f"    {span_type} {span_id}... {dur}ms")
                    if span.model:
                        print(f"      Model: {span.model}")
                    if span.tool_name:
                        print(f"      Tool: {span.tool_name}")
                    if span.error:
                        print(f"      Error: {self._c('31', span.error)}")

    async def export_async(self, traces: List[Trace]) -> None:
        self.export(traces)

    def shutdown(self) -> None:
        pass
