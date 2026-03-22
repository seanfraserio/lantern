"""Auto-instrumentation for HuggingFace Smolagents."""
from __future__ import annotations
from typing import Any, Optional, TYPE_CHECKING
from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


class LanternSmolagentsHandler:
    """Callback handler for Smolagents step-based agent lifecycle."""

    def __init__(self, tracer: "LanternTracer", *, agent_name: Optional[str] = None):
        self._tracer = tracer
        self._agent_name = agent_name or "smolagents-agent"
        self._trace_id: Optional[str] = None
        self._active_spans: dict[str, str] = {}

    def _ensure_trace(self) -> str:
        if self._trace_id is None:
            t = self._tracer.start_trace(agent_name=self._agent_name)
            self._trace_id = t.id
        return self._trace_id

    def on_step_start(self, step_name: str = "", step_number: int = 0, **kwargs: Any) -> str:
        tid = self._ensure_trace()
        span = self._tracer.start_span(
            tid,
            type="reasoning_step",
            input=SpanInput(prompt=f"Step {step_number}: {step_name}"),
        )
        self._active_spans[f"step_{step_number}"] = span.id
        return span.id

    def on_step_end(self, step_number: int = 0, output: str = "", **kwargs: Any) -> None:
        span_id = self._active_spans.pop(f"step_{step_number}", None)
        if span_id:
            self._tracer.end_span(span_id, SpanOutput(content=output))

    def on_llm_call(self, model: str = "", messages: list = None, **kwargs: Any) -> str:
        tid = self._ensure_trace()
        normalized = [{"role": m.get("role", ""), "content": str(m.get("content", ""))} for m in (messages or []) if isinstance(m, dict)]
        span = self._tracer.start_span(tid, type="llm_call", input=SpanInput(messages=normalized), model=model)
        return span.id

    def on_llm_end(self, span_id: str, output: str = "", input_tokens: int = 0, output_tokens: int = 0, **kwargs: Any) -> None:
        self._tracer.end_span(span_id, SpanOutput(content=output), input_tokens=input_tokens, output_tokens=output_tokens)

    def on_tool_start(self, tool_name: str, args: Any = None, **kwargs: Any) -> str:
        tid = self._ensure_trace()
        span = self._tracer.start_span(tid, type="tool_call", input=SpanInput(args=args), tool_name=tool_name)
        return span.id

    def on_tool_end(self, span_id: str, output: str = "", **kwargs: Any) -> None:
        self._tracer.end_span(span_id, SpanOutput(content=output))

    def finish(self) -> None:
        if self._trace_id:
            self._tracer.end_trace(self._trace_id, "success")
            self._trace_id = None


def create_lantern_smolagents_handler(tracer: "LanternTracer", *, agent_name: Optional[str] = None) -> LanternSmolagentsHandler:
    """Create a Lantern handler for Smolagents instrumentation."""
    return LanternSmolagentsHandler(tracer, agent_name=agent_name)
