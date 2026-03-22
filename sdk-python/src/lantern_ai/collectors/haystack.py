"""Auto-instrumentation for Haystack pipelines."""
from __future__ import annotations
from typing import Any, Optional, TYPE_CHECKING
from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


class LanternHaystackHandler:
    """Callback handler for Haystack pipeline and component lifecycle events."""

    def __init__(self, tracer: "LanternTracer", *, agent_name: Optional[str] = None):
        self._tracer = tracer
        self._agent_name = agent_name or "haystack-agent"
        self._trace_id: Optional[str] = None
        self._active_spans: dict[str, str] = {}

    def _ensure_trace(self) -> str:
        if self._trace_id is None:
            t = self._tracer.start_trace(agent_name=self._agent_name)
            self._trace_id = t.id
        return self._trace_id

    def on_pipeline_start(self, pipeline_name: str = "", **kwargs: Any) -> str:
        tid = self._ensure_trace()
        span = self._tracer.start_span(
            tid,
            type="custom",
            input=SpanInput(prompt=f"Pipeline: {pipeline_name}"),
        )
        self._active_spans[f"pipeline_{pipeline_name}"] = span.id
        return span.id

    def on_pipeline_end(self, pipeline_name: str = "", output: str = "", **kwargs: Any) -> None:
        span_id = self._active_spans.pop(f"pipeline_{pipeline_name}", None)
        if span_id:
            self._tracer.end_span(span_id, SpanOutput(content=output))

    def on_component_start(self, component_name: str = "", component_type: str = "", **kwargs: Any) -> str:
        """Track individual component execution. Retriever components get 'retrieval' span type."""
        tid = self._ensure_trace()
        span_type = "retrieval" if "retriever" in component_name.lower() else "custom"
        span = self._tracer.start_span(
            tid,
            type=span_type,
            input=SpanInput(prompt=f"Component: {component_name} ({component_type})"),
        )
        self._active_spans[f"component_{component_name}"] = span.id
        return span.id

    def on_component_end(self, component_name: str = "", output: str = "", **kwargs: Any) -> None:
        span_id = self._active_spans.pop(f"component_{component_name}", None)
        if span_id:
            self._tracer.end_span(span_id, SpanOutput(content=output))

    def on_llm_start(self, model: str = "", messages: list = None, **kwargs: Any) -> str:
        tid = self._ensure_trace()
        normalized = [{"role": m.get("role", ""), "content": str(m.get("content", ""))} for m in (messages or []) if isinstance(m, dict)]
        span = self._tracer.start_span(tid, type="llm_call", input=SpanInput(messages=normalized), model=model)
        return span.id

    def on_llm_end(self, span_id: str, output: str = "", input_tokens: int = 0, output_tokens: int = 0, **kwargs: Any) -> None:
        self._tracer.end_span(span_id, SpanOutput(content=output), input_tokens=input_tokens, output_tokens=output_tokens)

    def finish(self) -> None:
        if self._trace_id:
            self._tracer.end_trace(self._trace_id, "success")
            self._trace_id = None


def create_lantern_haystack_handler(tracer: "LanternTracer", *, agent_name: Optional[str] = None) -> LanternHaystackHandler:
    """Create a Lantern handler for Haystack instrumentation."""
    return LanternHaystackHandler(tracer, agent_name=agent_name)
