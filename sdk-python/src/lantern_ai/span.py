"""AgentSpan -- builder for creating and managing individual spans."""

from __future__ import annotations

import time
import uuid
from typing import Any, Dict, List, Optional

from .types import Span, SpanInput, SpanOutput


# ---------------------------------------------------------------------------
# Cost estimation
# ---------------------------------------------------------------------------

# Prices in USD per 1 000 tokens
_MODEL_PRICING: Dict[str, Dict[str, float]] = {
    "claude-sonnet-4-5-20251001": {"input": 0.003, "output": 0.015},
    "claude-haiku-4-5-20251001": {"input": 0.0008, "output": 0.004},
    "claude-opus-4-5-20251001": {"input": 0.015, "output": 0.075},
    "gpt-4o": {"input": 0.005, "output": 0.015},
    "gpt-4o-mini": {"input": 0.00015, "output": 0.0006},
}

_DEFAULT_PRICING = {"input": 0.001, "output": 0.002}


def estimate_cost(model: str, input_tokens: int, output_tokens: int) -> float:
    """Return a rough cost estimate in USD for the given token counts."""
    prices = _MODEL_PRICING.get(model, _DEFAULT_PRICING)
    return (input_tokens / 1000) * prices["input"] + (output_tokens / 1000) * prices["output"]


# ---------------------------------------------------------------------------
# AgentSpan
# ---------------------------------------------------------------------------


class AgentSpan:
    """Builder / context-manager for a single span within a trace.

    Can be used standalone::

        span = AgentSpan(trace_id="...", type="llm_call")
        span.set_input(messages=[...])
        span.set_output(content="...")
        span.set_tokens(10, 20)
        span.end()

    Or as a context manager::

        with AgentSpan(trace_id="...", type="llm_call") as span:
            span.set_input(messages=[...])
            span.set_output(content="...")
    """

    def __init__(
        self,
        trace_id: str,
        type: str,  # noqa: A002 – shadows builtin on purpose
        *,
        model: Optional[str] = None,
        tool_name: Optional[str] = None,
        parent_span_id: Optional[str] = None,
        input: Optional[SpanInput] = None,  # noqa: A002
    ) -> None:
        self._span = Span(
            id=str(uuid.uuid4()),
            trace_id=trace_id,
            parent_span_id=parent_span_id,
            type=type,
            start_time=time.time() * 1000,
            model=model,
            tool_name=tool_name,
            input=input or SpanInput(),
        )

    # -- Properties ----------------------------------------------------------

    @property
    def id(self) -> str:
        return self._span.id

    @property
    def trace_id(self) -> str:
        return self._span.trace_id

    # -- Setters -------------------------------------------------------------

    def set_input(
        self,
        *,
        messages: Optional[List[Dict[str, str]]] = None,
        prompt: Optional[str] = None,
        args: Optional[Any] = None,
    ) -> None:
        """Set the input payload for this span."""
        self._span.input = SpanInput(messages=messages, prompt=prompt, args=args)

    def set_output(
        self,
        *,
        content: Optional[str] = None,
        tool_calls: Optional[List[Any]] = None,
        stop_reason: Optional[str] = None,
    ) -> None:
        """Set the output payload for this span."""
        self._span.output = SpanOutput(
            content=content, tool_calls=tool_calls, stop_reason=stop_reason
        )

    def set_tokens(self, input_tokens: int, output_tokens: int) -> None:
        """Record token usage and compute estimated cost."""
        self._span.input_tokens = input_tokens
        self._span.output_tokens = output_tokens
        if self._span.model:
            self._span.estimated_cost_usd = estimate_cost(
                self._span.model, input_tokens, output_tokens
            )

    def set_error(self, error_message: str) -> None:
        """Record an error message on this span."""
        self._span.error = error_message

    # -- Lifecycle -----------------------------------------------------------

    def end(
        self,
        output: Optional[SpanOutput] = None,
        *,
        input_tokens: Optional[int] = None,
        output_tokens: Optional[int] = None,
        error: Optional[str] = None,
    ) -> Span:
        """Finalize the span, computing duration and cost.

        Accepts optional *output*, *input_tokens*, *output_tokens*, and *error*
        so callers can set everything in one call (matches the TypeScript API).

        Returns the finalized :class:`Span` dataclass.
        """
        self._span.end_time = time.time() * 1000
        self._span.duration_ms = self._span.end_time - self._span.start_time

        if output is not None:
            self._span.output = output
        if input_tokens is not None:
            self._span.input_tokens = input_tokens
        if output_tokens is not None:
            self._span.output_tokens = output_tokens
        if error is not None:
            self._span.error = error

        if (
            self._span.input_tokens is not None
            and self._span.output_tokens is not None
            and self._span.model
        ):
            self._span.estimated_cost_usd = estimate_cost(
                self._span.model,
                self._span.input_tokens,
                self._span.output_tokens,
            )

        return self._span

    def to_span(self) -> Span:
        """Return a snapshot copy of the underlying Span dataclass."""
        import copy

        return copy.copy(self._span)

    # -- Context-manager support ---------------------------------------------

    def __enter__(self) -> "AgentSpan":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        if exc_type is not None:
            self.set_error(str(exc_val))
        if self._span.end_time is None:
            self.end()
