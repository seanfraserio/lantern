"""Tests for wrap_openai_client — monkey-patches and span recording."""

import pytest
from unittest.mock import MagicMock, AsyncMock

from lantern_ai.collectors.openai import wrap_openai_client
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter: MockExporter) -> LanternTracer:
    t = LanternTracer(
        service_name="svc",
        exporter=mock_exporter,
        flush_interval=9999,
    )
    t._flush_timer.cancel()
    return t


def _make_chat_response(content="Hello!", finish_reason="stop", tool_calls=None):
    response = MagicMock()
    response.usage = MagicMock(prompt_tokens=10, completion_tokens=20)

    message = MagicMock()
    message.content = content
    message.tool_calls = tool_calls

    choice = MagicMock()
    choice.message = message
    choice.finish_reason = finish_reason
    response.choices = [choice]
    return response


def _make_sync_client(response=None):
    client = MagicMock()
    if response is None:
        response = _make_chat_response()
    client.chat.completions.create = MagicMock(return_value=response)
    return client, response


def _make_async_client(response=None):
    client = MagicMock()
    if response is None:
        response = _make_chat_response()
    client.chat.completions.create = AsyncMock(return_value=response)
    return client, response


class TestWrapSyncOpenAIClient:
    def test_returns_same_client(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        result = wrap_openai_client(client, tracer)
        assert result is client

    def test_patches_chat_completions_create(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        original = client.chat.completions.create
        wrap_openai_client(client, tracer)
        assert client.chat.completions.create is not original

    def test_creates_trace_on_call(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        wrap_openai_client(client, tracer)

        client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        assert trace.status == "success"

    def test_records_llm_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        wrap_openai_client(client, tracer)

        client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1

    def test_records_token_counts(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        wrap_openai_client(client, tracer)

        client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.total_input_tokens == 10
        assert trace.total_output_tokens == 20

    def test_error_sets_trace_status_error(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        client.chat.completions.create = MagicMock(side_effect=RuntimeError("API error"))
        wrap_openai_client(client, tracer)

        with pytest.raises(RuntimeError):
            client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
            )
        tracer.flush()

        assert mock_exporter.all_traces[0].status == "error"

    def test_tool_call_creates_child_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)

        fn = MagicMock()
        fn.name = "get_weather"
        fn.arguments = '{"location": "NYC"}'
        tc = MagicMock()
        tc.id = "tc-1"
        tc.function = fn

        response = _make_chat_response(finish_reason="tool_calls", tool_calls=[tc])
        client, _ = _make_sync_client(response=response)
        wrap_openai_client(client, tracer)

        client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "weather?"}],
        )
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        tool_spans = [s for s in trace.spans if s.type == "tool_call"]
        assert len(tool_spans) == 1
        assert tool_spans[0].tool_name == "get_weather"

    def test_default_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        wrap_openai_client(client, tracer)

        client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        assert mock_exporter.all_traces[0].agent_name == "openai-agent"

    def test_existing_trace_id_used(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()

        trace = tracer.start_trace()
        wrap_openai_client(client, tracer, trace_id=trace.id)
        client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.end_trace(trace.id)
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        assert mock_exporter.all_traces[0].id == trace.id


class TestWrapAsyncOpenAIClient:
    @pytest.mark.asyncio
    async def test_async_creates_trace(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_async_client()
        wrap_openai_client(client, tracer)

        await client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        assert mock_exporter.all_traces[0].status == "success"
