"""Auto-instrumentation for the OpenAI Python SDK.

Usage::

    from openai import OpenAI
    from lantern_ai import LanternTracer, wrap_openai_client

    tracer = LanternTracer(...)
    client = OpenAI()
    wrap_openai_client(client, tracer)

    # All client.chat.completions.create() calls are now traced automatically.
"""

from __future__ import annotations

import functools
from typing import Any, Optional, TYPE_CHECKING

from ..types import SpanInput, SpanOutput

if TYPE_CHECKING:
    from ..tracer import LanternTracer


def wrap_openai_client(
    client: Any,
    tracer: "LanternTracer",
    *,
    trace_id: Optional[str] = None,
    agent_name: Optional[str] = None,
) -> Any:
    """Monkey-patch an OpenAI client so every ``chat.completions.create()``
    call is automatically recorded as an ``llm_call`` span.

    Handles both the sync (``OpenAI``) and async (``AsyncOpenAI``) clients.
    The original response object is returned unchanged.

    Parameters
    ----------
    client:
        An ``openai.OpenAI`` or ``openai.AsyncOpenAI`` instance.
    tracer:
        The :class:`LanternTracer` to record spans on.
    trace_id:
        If provided, spans are added to this existing trace. Otherwise a
        new trace is created per call.
    agent_name:
        Agent name to use when auto-creating traces (default
        ``"openai-agent"``).

    Returns
    -------
    The same *client* instance (mutated in place).
    """

    original_create = client.chat.completions.create

    import asyncio

    is_async = asyncio.iscoroutinefunction(original_create)

    def _extract_messages(params: dict) -> list:
        messages = []
        for m in params.get("messages", []):
            content = m.get("content") or ""
            messages.append({"role": m.get("role", ""), "content": str(content)})
        return messages

    def _build_output(response: Any) -> tuple:
        """Return (SpanOutput, tool_calls_list)."""
        choices = getattr(response, "choices", [])
        first = choices[0] if choices else None
        message = getattr(first, "message", None) if first else None

        text_content = getattr(message, "content", "") or "" if message else ""
        finish_reason = getattr(first, "finish_reason", None) if first else None

        tool_calls = []
        raw_tool_calls = getattr(message, "tool_calls", None) if message else None
        if raw_tool_calls:
            for tc in raw_tool_calls:
                fn = getattr(tc, "function", None)
                tool_calls.append({
                    "id": getattr(tc, "id", None),
                    "name": getattr(fn, "name", None) if fn else None,
                    "input": getattr(fn, "arguments", None) if fn else None,
                })

        output = SpanOutput(
            content=text_content,
            tool_calls=tool_calls if tool_calls else None,
            stop_reason=finish_reason,
        )
        return output, tool_calls

    if is_async:

        @functools.wraps(original_create)
        async def _wrapped_create_async(*args: Any, **kwargs: Any) -> Any:
            params = kwargs

            tid = trace_id
            own_trace = False
            if tid is None:
                t = tracer.start_trace(agent_name=agent_name or "openai-agent")
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
                    input_tokens=getattr(usage, "prompt_tokens", None),
                    output_tokens=getattr(usage, "completion_tokens", None),
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

        client.chat.completions.create = _wrapped_create_async

    else:

        @functools.wraps(original_create)
        def _wrapped_create_sync(*args: Any, **kwargs: Any) -> Any:
            params = kwargs

            tid = trace_id
            own_trace = False
            if tid is None:
                t = tracer.start_trace(agent_name=agent_name or "openai-agent")
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
                    input_tokens=getattr(usage, "prompt_tokens", None),
                    output_tokens=getattr(usage, "completion_tokens", None),
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

        client.chat.completions.create = _wrapped_create_sync

    return client
