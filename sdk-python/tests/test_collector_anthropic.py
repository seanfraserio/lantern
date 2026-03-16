"""Tests for wrap_anthropic_client — monkey-patches and span recording."""

import pytest
from unittest.mock import MagicMock, AsyncMock

from lantern_ai.collectors.anthropic import wrap_anthropic_client
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


def _make_sync_client() -> MagicMock:
    """Fake synchronous Anthropic client."""
    client = MagicMock()
    response = MagicMock()
    response.stop_reason = "end_turn"
    response.usage = MagicMock(input_tokens=10, output_tokens=20)

    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = "Hello!"
    response.content = [text_block]

    client.messages.create = MagicMock(return_value=response)
    return client, response


def _make_async_client() -> MagicMock:
    """Fake async Anthropic client."""
    client = MagicMock()
    response = MagicMock()
    response.stop_reason = "end_turn"
    response.usage = MagicMock(input_tokens=5, output_tokens=15)

    text_block = MagicMock()
    text_block.type = "text"
    text_block.text = "Async hello!"
    response.content = [text_block]

    client.messages.create = AsyncMock(return_value=response)
    return client, response


class TestWrapSyncClient:
    def test_returns_same_client(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        result = wrap_anthropic_client(client, tracer)
        assert result is client

    def test_patches_messages_create(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        original = client.messages.create
        wrap_anthropic_client(client, tracer)
        assert client.messages.create is not original

    def test_creates_trace_and_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        wrap_anthropic_client(client, tracer)

        client.messages.create(
            model="claude-3-5-sonnet-20241022",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        assert trace.status == "success"
        assert len(trace.spans) >= 1
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1

    def test_records_token_counts(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        wrap_anthropic_client(client, tracer)

        client.messages.create(
            model="claude-3-5-sonnet-20241022",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.total_input_tokens == 10
        assert trace.total_output_tokens == 20

    def test_error_sets_trace_status_to_error(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()
        client.messages.create = MagicMock(side_effect=RuntimeError("API down"))
        wrap_anthropic_client(client, tracer)

        with pytest.raises(RuntimeError):
            client.messages.create(
                model="claude-3-5-sonnet-20241022",
                messages=[{"role": "user", "content": "hi"}],
            )
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        assert mock_exporter.all_traces[0].status == "error"

    def test_tool_call_creates_child_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client = MagicMock()

        response = MagicMock()
        response.stop_reason = "tool_use"
        response.usage = MagicMock(input_tokens=5, output_tokens=5)
        tool_block = MagicMock()
        tool_block.type = "tool_use"
        tool_block.id = "tool-1"
        tool_block.name = "search"
        tool_block.input = {"query": "hello"}
        response.content = [tool_block]
        client.messages.create = MagicMock(return_value=response)

        wrap_anthropic_client(client, tracer)
        client.messages.create(
            model="claude-3-5-sonnet-20241022",
            messages=[{"role": "user", "content": "search for something"}],
        )
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        tool_spans = [s for s in trace.spans if s.type == "tool_call"]
        assert len(tool_spans) == 1
        assert tool_spans[0].tool_name == "search"

    def test_existing_trace_id_used(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_sync_client()

        trace = tracer.start_trace()
        wrap_anthropic_client(client, tracer, trace_id=trace.id)
        client.messages.create(
            model="claude-3-5-sonnet-20241022",
            messages=[{"role": "user", "content": "hi"}],
        )
        # Trace was not auto-ended since we provided trace_id
        tracer.end_trace(trace.id)
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        assert mock_exporter.all_traces[0].id == trace.id


class TestWrapAsyncClient:
    @pytest.mark.asyncio
    async def test_async_creates_trace(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        client, _ = _make_async_client()
        wrap_anthropic_client(client, tracer)

        await client.messages.create(
            model="claude-3-5-sonnet-20241022",
            messages=[{"role": "user", "content": "hi"}],
        )
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        assert trace.status == "success"
