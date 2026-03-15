"""Auto-instrumentation for the Anthropic Python SDK.

Usage::

    from anthropic import Anthropic
    from lantern_ai import LanternTracer, wrap_anthropic_client

    tracer = LanternTracer(...)
    client = Anthropic()
    wrap_anthropic_client(client, tracer)

    # All client.messages.create() calls are now traced automatically.
"""

from __future__ import annotations

import functools
import json
from typing import Any, Optional, TYPE_CHECKING

from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


def wrap_anthropic_client(
    client: Any,
    tracer: "LanternTracer",
    *,
    trace_id: Optional[str] = None,
    agent_name: Optional[str] = None,
) -> Any:
    """Monkey-patch an Anthropic client so every ``messages.create()`` call
    is automatically recorded as an ``llm_call`` span.

    Handles both the sync (``Anthropic``) and async (``AsyncAnthropic``)
    clients.  The original response object is returned unchanged.

    Parameters
    ----------
    client:
        An ``anthropic.Anthropic`` or ``anthropic.AsyncAnthropic`` instance.
    tracer:
        The :class:`LanternTracer` to record spans on.
    trace_id:
        If provided, spans are added to this existing trace. Otherwise a
        new trace is created per call.
    agent_name:
        Agent name to use when auto-creating traces (default
        ``"anthropic-agent"``).

    Returns
    -------
    The same *client* instance (mutated in place).
    """

    original_create = client.messages.create

    # Detect whether the original is a coroutine function (async client)
    import asyncio

    is_async = asyncio.iscoroutinefunction(original_create)

    def _extract_messages(params: dict) -> list:
        messages = []
        for m in params.get("messages", []):
            content = m.get("content", "")
            if isinstance(content, list):
                text_parts = []
                for block in content:
                    if isinstance(block, dict):
                        text_parts.append(block.get("text", json.dumps(block)))
                    else:
                        text_parts.append(str(block))
                content = "".join(text_parts)
            messages.append({"role": m.get("role", ""), "content": str(content)})
        return messages

    def _build_output(response: Any) -> tuple:
        """Return (SpanOutput, tool_calls_list)."""
        content_blocks = getattr(response, "content", [])
        text_parts = []
        tool_calls = []
        for block in content_blocks:
            block_type = getattr(block, "type", None)
            if block_type == "text":
                text_parts.append(getattr(block, "text", ""))
            elif block_type == "tool_use":
                tool_calls.append({
                    "id": getattr(block, "id", None),
                    "name": getattr(block, "name", None),
                    "input": getattr(block, "input", None),
                })

        output = SpanOutput(
            content="".join(text_parts),
            tool_calls=tool_calls if tool_calls else None,
            stop_reason=getattr(response, "stop_reason", None),
        )
        return output, tool_calls

    if is_async:

        @functools.wraps(original_create)
        async def _wrapped_create_async(*args: Any, **kwargs: Any) -> Any:
            # Merge positional into kwargs for introspection
            params = kwargs

            tid = trace_id
            own_trace = False
            if tid is None:
                t = tracer.start_trace(agent_name=agent_name or "anthropic-agent")
                tid = t.id
                own_trace = True

            messages = _extract_messages(params)
            span = tracer.start_span(
                tid,
                type="llm_call",
                input=SpanInput(messages=messages),
                model=params.get("model", "unknown"),
            )

            try:
                response = await original_create(*args, **kwargs)

                output, tool_calls = _build_output(response)
                usage = getattr(response, "usage", None)
                tracer.end_span(
                    span.id,
                    output,
                    input_tokens=getattr(usage, "input_tokens", None),
                    output_tokens=getattr(usage, "output_tokens", None),
                )

                # Child spans for tool calls
                for tool in tool_calls:
                    tool_span = tracer.start_span(
                        tid,
                        type="tool_call",
                        parent_span_id=span.id,
                        input=SpanInput(args=tool.get("input")),
                        tool_name=tool.get("name"),
                    )
                    tracer.end_span(
                        tool_span.id,
                        SpanOutput(content="Tool call initiated"),
                    )

                if own_trace:
                    tracer.end_trace(tid, "success")

                return response

            except Exception as exc:
                tracer.end_span(
                    span.id,
                    SpanOutput(),
                    error=str(exc),
                )
                if own_trace:
                    tracer.end_trace(tid, "error")
                raise

        client.messages.create = _wrapped_create_async

    else:

        @functools.wraps(original_create)
        def _wrapped_create_sync(*args: Any, **kwargs: Any) -> Any:
            params = kwargs

            tid = trace_id
            own_trace = False
            if tid is None:
                t = tracer.start_trace(agent_name=agent_name or "anthropic-agent")
                tid = t.id
                own_trace = True

            messages = _extract_messages(params)
            span = tracer.start_span(
                tid,
                type="llm_call",
                input=SpanInput(messages=messages),
                model=params.get("model", "unknown"),
            )

            try:
                response = original_create(*args, **kwargs)

                output, tool_calls = _build_output(response)
                usage = getattr(response, "usage", None)
                tracer.end_span(
                    span.id,
                    output,
                    input_tokens=getattr(usage, "input_tokens", None),
                    output_tokens=getattr(usage, "output_tokens", None),
                )

                for tool in tool_calls:
                    tool_span = tracer.start_span(
                        tid,
                        type="tool_call",
                        parent_span_id=span.id,
                        input=SpanInput(args=tool.get("input")),
                        tool_name=tool.get("name"),
                    )
                    tracer.end_span(
                        tool_span.id,
                        SpanOutput(content="Tool call initiated"),
                    )

                if own_trace:
                    tracer.end_trace(tid, "success")

                return response

            except Exception as exc:
                tracer.end_span(
                    span.id,
                    SpanOutput(),
                    error=str(exc),
                )
                if own_trace:
                    tracer.end_trace(tid, "error")
                raise

        client.messages.create = _wrapped_create_sync

    return client
