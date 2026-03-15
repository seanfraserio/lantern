"""LanternTracer -- core tracer that manages traces, spans, and export."""

from __future__ import annotations

import threading
import time
import uuid
from typing import Any, Dict, List, Optional, TYPE_CHECKING

from .span import AgentSpan
from .types import Span, SpanInput, SpanOutput, Trace, TraceSource, TraceStatus

if TYPE_CHECKING:
    from .exporters.base import TraceExporter


class LanternTracer:
    """Core tracer for Lantern.

    Manages traces and spans, buffers completed traces, and exports them via
    the configured exporter (either on flush or when the batch is full).

    Parameters
    ----------
    service_name:
        Logical name of the service producing traces.
    agent_name:
        Default agent name used when ``start_trace`` is called without one.
    agent_version:
        Optional version string for the agent.
    environment:
        Deployment environment (``"production"``, ``"staging"``, etc.).
    exporter:
        An object implementing ``export(traces)`` / ``shutdown()``.
        If not provided, *api_key* and *endpoint* are used to create a
        :class:`LanternExporter` automatically.
    api_key:
        API key for the Lantern ingest service.
    endpoint:
        Base URL for the Lantern ingest service.
    batch_size:
        Number of traces to buffer before auto-flushing (default 50).
    flush_interval:
        Seconds between periodic background flushes (default 5.0).
    """

    def __init__(
        self,
        service_name: str = "unknown",
        *,
        agent_name: str = "default-agent",
        agent_version: Optional[str] = None,
        environment: str = "production",
        exporter: Optional["TraceExporter"] = None,
        api_key: Optional[str] = None,
        endpoint: Optional[str] = None,
        batch_size: int = 50,
        flush_interval: float = 5.0,
    ) -> None:
        self._service_name = service_name
        self._agent_name = agent_name
        self._agent_version = agent_version
        self._environment = environment
        self._batch_size = batch_size
        self._flush_interval = flush_interval

        # Resolve exporter
        if exporter is not None:
            self._exporter = exporter
        elif api_key and endpoint:
            from .exporters.lantern import LanternExporter

            self._exporter = LanternExporter(endpoint=endpoint, api_key=api_key)
        else:
            raise ValueError(
                "Either 'exporter' or both 'api_key' and 'endpoint' must be provided."
            )

        self._source = TraceSource(
            service_name=self._service_name,
            sdk_version="0.1.0",
            exporter_type=self._exporter.exporter_type,
        )

        # Internal state
        self._traces: Dict[str, Trace] = {}
        self._active_spans: Dict[str, AgentSpan] = {}
        self._buffer: List[Trace] = []
        self._lock = threading.Lock()

        # Periodic flush timer (daemon so it won't keep the process alive)
        self._flush_timer: Optional[threading.Timer] = None
        self._start_flush_timer()

    # -- Periodic flush ------------------------------------------------------

    def _start_flush_timer(self) -> None:
        self._flush_timer = threading.Timer(self._flush_interval, self._periodic_flush)
        self._flush_timer.daemon = True
        self._flush_timer.start()

    def _periodic_flush(self) -> None:
        try:
            self.flush()
        except Exception:
            pass
        # Reschedule
        self._start_flush_timer()

    # -- Trace lifecycle -----------------------------------------------------

    def start_trace(
        self,
        agent_name: Optional[str] = None,
        *,
        agent_version: Optional[str] = None,
        session_id: Optional[str] = None,
        environment: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> Trace:
        """Start a new trace for an agent execution."""
        trace = Trace(
            id=str(uuid.uuid4()),
            session_id=session_id or str(uuid.uuid4()),
            agent_name=agent_name or self._agent_name,
            agent_version=agent_version or self._agent_version,
            environment=environment or self._environment,
            start_time=time.time() * 1000,
            status="running",
            spans=[],
            metadata=metadata or {},
            source=self._source,
            total_input_tokens=0,
            total_output_tokens=0,
            estimated_cost_usd=0.0,
        )

        with self._lock:
            self._traces[trace.id] = trace

        return trace

    def end_trace(self, trace_id: str, status: TraceStatus = "success") -> None:
        """Finalize a trace and move it into the export buffer."""
        with self._lock:
            trace = self._traces.get(trace_id)
            if trace is None:
                raise KeyError(f"Trace {trace_id} not found")

            trace.end_time = time.time() * 1000
            trace.duration_ms = trace.end_time - trace.start_time
            trace.status = status

            self._buffer.append(trace)
            del self._traces[trace_id]

        # Auto-flush when buffer is full
        if len(self._buffer) >= self._batch_size:
            self.flush()

    def get_trace(self, trace_id: str) -> Optional[Trace]:
        """Return a trace by ID (for inspection), or ``None``."""
        return self._traces.get(trace_id)

    # -- Span lifecycle ------------------------------------------------------

    def start_span(
        self,
        trace_id: str,
        *,
        type: str,  # noqa: A002
        model: Optional[str] = None,
        tool_name: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        input: Optional[SpanInput] = None,  # noqa: A002
    ) -> AgentSpan:
        """Start a new span within a trace. Returns an :class:`AgentSpan`."""
        if trace_id not in self._traces:
            raise KeyError(f"Trace {trace_id} not found")

        span = AgentSpan(
            trace_id=trace_id,
            type=type,
            model=model,
            tool_name=tool_name,
            parent_span_id=parent_span_id,
            input=input,
        )

        with self._lock:
            self._active_spans[span.id] = span

        return span

    def end_span(
        self,
        span_id: str,
        output: Optional[SpanOutput] = None,
        *,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        error: Optional[str] = None,
    ) -> None:
        """End an active span with its output and record it on the trace."""
        with self._lock:
            agent_span = self._active_spans.get(span_id)
            if agent_span is None:
                raise KeyError(f"Span {span_id} not found or already ended")

            completed = agent_span.end(
                output=output,
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                error=error,
            )

            trace = self._traces.get(completed.trace_id)
            if trace is not None:
                trace.spans.append(completed)
                trace.total_input_tokens += completed.input_tokens or 0
                trace.total_output_tokens += completed.output_tokens or 0
                trace.estimated_cost_usd += completed.estimated_cost_usd or 0

            del self._active_spans[span_id]

    # -- Export --------------------------------------------------------------

    def flush(self) -> None:
        """Flush all buffered traces to the exporter (synchronously)."""
        with self._lock:
            if not self._buffer:
                return
            to_export = list(self._buffer)
            self._buffer.clear()

        try:
            self._exporter.export(to_export)
        except Exception:
            # Put traces back so they aren't lost
            with self._lock:
                self._buffer = to_export + self._buffer
            raise

    async def flush_async(self) -> None:
        """Flush all buffered traces to the exporter (async variant)."""
        with self._lock:
            if not self._buffer:
                return
            to_export = list(self._buffer)
            self._buffer.clear()

        try:
            await self._exporter.export_async(to_export)
        except Exception:
            with self._lock:
                self._buffer = to_export + self._buffer
            raise

    def shutdown(self) -> None:
        """Flush remaining traces, stop the timer, and close the exporter."""
        if self._flush_timer is not None:
            self._flush_timer.cancel()
            self._flush_timer = None

        self.flush()
        self._exporter.shutdown()

    async def shutdown_async(self) -> None:
        """Async variant of :meth:`shutdown`."""
        if self._flush_timer is not None:
            self._flush_timer.cancel()
            self._flush_timer = None

        await self.flush_async()
        await self._exporter.shutdown_async()
