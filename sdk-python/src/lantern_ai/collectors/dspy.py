"""Auto-instrumentation for DSPy."""
from __future__ import annotations
from typing import Any, Optional, TYPE_CHECKING
from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


class LanternDSPyHandler:
    """Callback handler for DSPy module-level tracing."""

    def __init__(self, tracer: "LanternTracer", *, agent_name: Optional[str] = None):
        self._tracer = tracer
        self._agent_name = agent_name or "dspy-agent"
        self._trace_id: Optional[str] = None
        self._active_spans: dict[str, str] = {}

    def _ensure_trace(self) -> str:
        if self._trace_id is None:
            t = self._tracer.start_trace(agent_name=self._agent_name)
            self._trace_id = t.id
        return self._trace_id

    def on_predict_start(self, module_name: str = "", inputs: Any = None, **kwargs: Any) -> str:
        """Track DSPy module predict calls."""
        tid = self._ensure_trace()
        span = self._tracer.start_span(
            tid,
            type="custom",
            input=SpanInput(prompt=f"Predict: {module_name}", args=inputs),
        )
        self._active_spans[f"predict_{module_name}"] = span.id
        return span.id

    def on_predict_end(self, module_name: str = "", output: str = "", **kwargs: Any) -> None:
        span_id = self._active_spans.pop(f"predict_{module_name}", None)
        if span_id:
            self._tracer.end_span(span_id, SpanOutput(content=output))

    def on_llm_start(self, model: str = "", messages: list = None, **kwargs: Any) -> str:
        tid = self._ensure_trace()
        normalized = [{"role": m.get("role", ""), "content": str(m.get("content", ""))} for m in (messages or []) if isinstance(m, dict)]
        span = self._tracer.start_span(tid, type="llm_call", input=SpanInput(messages=normalized), model=model)
        return span.id

    def on_llm_end(self, span_id: str, output: str = "", input_tokens: int = 0, output_tokens: int = 0, **kwargs: Any) -> None:
        self._tracer.end_span(span_id, SpanOutput(content=output), input_tokens=input_tokens, output_tokens=output_tokens)

    def on_retriever_start(self, query: str = "", **kwargs: Any) -> str:
        tid = self._ensure_trace()
        span = self._tracer.start_span(tid, type="retrieval", input=SpanInput(prompt=query))
        return span.id

    def on_retriever_end(self, span_id: str, output: str = "", **kwargs: Any) -> None:
        self._tracer.end_span(span_id, SpanOutput(content=output))

    def finish(self) -> None:
        if self._trace_id:
            self._tracer.end_trace(self._trace_id, "success")
            self._trace_id = None


def create_lantern_dspy_handler(tracer: "LanternTracer", *, agent_name: Optional[str] = None) -> LanternDSPyHandler:
    """Create a Lantern handler for DSPy instrumentation."""
    return LanternDSPyHandler(tracer, agent_name=agent_name)
