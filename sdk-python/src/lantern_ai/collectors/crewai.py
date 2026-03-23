"""Auto-instrumentation for CrewAI.

Usage::

    from crewai import Crew
    from lantern_ai import LanternTracer
    from lantern_ai.collectors.crewai import create_lantern_crewai_handler

    tracer = LanternTracer(...)
    handler = create_lantern_crewai_handler(tracer)
    # Pass handler to crew or use as step callback
"""

from __future__ import annotations

from typing import Any, Optional, TYPE_CHECKING

from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


class LanternCrewAIHandler:
    """Callback handler for CrewAI task and agent lifecycle events."""

    def __init__(self, tracer: "LanternTracer", *, agent_name: Optional[str] = None):
        self._tracer = tracer
        self._agent_name = agent_name or "crewai-agent"
        self._active_spans: dict[str, str] = {}  # task_name -> span_id
        self._trace_id: Optional[str] = None

    def _ensure_trace(self) -> str:
        if self._trace_id is None:
            t = self._tracer.start_trace(agent_name=self._agent_name)
            self._trace_id = t.id
        return self._trace_id

    def on_task_start(self, task_name: str, agent_name: str = "", **kwargs: Any) -> None:
        tid = self._ensure_trace()
        span = self._tracer.start_span(
            tid,
            type="custom",
            input=SpanInput(prompt=f"Task: {task_name}, Agent: {agent_name}"),
        )
        self._active_spans[task_name] = span.id

    def on_task_end(self, task_name: str, output: str = "", **kwargs: Any) -> None:
        span_id = self._active_spans.pop(task_name, None)
        if span_id:
            self._tracer.end_span(span_id, SpanOutput(content=output))

    def on_llm_start(self, model: str = "", messages: list = None, **kwargs: Any) -> str:
        tid = self._ensure_trace()
        normalized = []
        for m in (messages or []):
            if isinstance(m, dict):
                normalized.append({"role": m.get("role", ""), "content": str(m.get("content", ""))})
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


def create_lantern_crewai_handler(
    tracer: "LanternTracer",
    *,
    agent_name: Optional[str] = None,
) -> LanternCrewAIHandler:
    """Create a Lantern handler for CrewAI instrumentation."""
    return LanternCrewAIHandler(tracer, agent_name=agent_name)
