"""Auto-instrumentation for AutoGen/AG2."""
from __future__ import annotations
from typing import Any, Optional, TYPE_CHECKING
from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


class LanternAutoGenHandler:
    """Callback handler for AutoGen agent message passing and LLM calls."""

    def __init__(self, tracer: "LanternTracer", *, agent_name: Optional[str] = None):
        self._tracer = tracer
        self._agent_name = agent_name or "autogen-agent"
        self._trace_id: Optional[str] = None
        self._active_spans: dict[str, str] = {}

    def _ensure_trace(self) -> str:
        if self._trace_id is None:
            t = self._tracer.start_trace(agent_name=self._agent_name)
            self._trace_id = t.id
        return self._trace_id

    def on_message(self, sender: str = "", recipient: str = "", content: str = "", **kwargs: Any) -> str:
        """Track agent-to-agent message passing."""
        tid = self._ensure_trace()
        span = self._tracer.start_span(
            tid,
            type="custom",
            input=SpanInput(prompt=f"{sender} -> {recipient}: {content}"),
        )
        self._active_spans[f"msg_{sender}_{recipient}"] = span.id
        return span.id

    def on_message_end(self, span_id: str, output: str = "", **kwargs: Any) -> None:
        self._tracer.end_span(span_id, SpanOutput(content=output))

    def on_llm_start(self, model: str = "", messages: list = None, **kwargs: Any) -> str:
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


def create_lantern_autogen_handler(tracer: "LanternTracer", *, agent_name: Optional[str] = None) -> LanternAutoGenHandler:
    """Create a Lantern handler for AutoGen instrumentation."""
    return LanternAutoGenHandler(tracer, agent_name=agent_name)
