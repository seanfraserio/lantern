"""Tests for LanternTracer lifecycle, flush, and batching."""

import pytest
from unittest.mock import MagicMock, patch

from lantern_ai.tracer import LanternTracer
from lantern_ai.types import SpanOutput
from .conftest import MockExporter


class TestLanternTracerInit:
    def test_requires_exporter_or_api_key(self):
        with pytest.raises(ValueError, match="exporter"):
            LanternTracer(service_name="svc")

    def test_accepts_exporter(self, mock_exporter):
        t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
        assert t._exporter is mock_exporter
        t._flush_timer.cancel()

    def test_accepts_api_key_and_endpoint(self):
        t = LanternTracer(
            service_name="svc",
            api_key="key",
            endpoint="https://example.com",
            flush_interval=9999,
        )
        from lantern_ai.exporters.lantern import LanternExporter
        assert isinstance(t._exporter, LanternExporter)
        t._flush_timer.cancel()

    def test_source_is_set(self, tracer):
        assert tracer._source.service_name == "test-service"
        assert tracer._source.sdk_version is not None


class TestTraceLifecycle:
    def test_start_trace_returns_trace(self, tracer):
        trace = tracer.start_trace()
        assert trace.id
        assert trace.status == "running"

    def test_start_trace_uses_default_agent_name(self, tracer):
        trace = tracer.start_trace()
        assert trace.agent_name == "test-agent"

    def test_start_trace_custom_agent_name(self, tracer):
        trace = tracer.start_trace(agent_name="custom-bot")
        assert trace.agent_name == "custom-bot"

    def test_start_trace_registers_in_active(self, tracer):
        trace = tracer.start_trace()
        assert tracer.get_trace(trace.id) is trace

    def test_end_trace_moves_to_buffer(self, tracer):
        trace = tracer.start_trace()
        tracer.end_trace(trace.id, "success")
        assert tracer.get_trace(trace.id) is None
        assert len(tracer._buffer) == 1

    def test_end_trace_sets_status(self, tracer):
        trace = tracer.start_trace()
        tracer.end_trace(trace.id, "error")
        assert tracer._buffer[0].status == "error"

    def test_end_trace_sets_timing(self, tracer):
        trace = tracer.start_trace()
        tracer.end_trace(trace.id)
        buffered = tracer._buffer[0]
        assert buffered.end_time is not None
        assert buffered.duration_ms >= 0

    def test_end_nonexistent_trace_raises(self, tracer):
        with pytest.raises(KeyError):
            tracer.end_trace("nonexistent-id")


class TestSpanLifecycle:
    def test_start_span_requires_active_trace(self, tracer):
        with pytest.raises(KeyError):
            tracer.start_span("bad-trace-id", type="custom")

    def test_start_span_returns_agent_span(self, tracer):
        trace = tracer.start_trace()
        span = tracer.start_span(trace.id, type="llm_call")
        assert span.trace_id == trace.id

    def test_end_span_records_on_trace(self, tracer):
        trace = tracer.start_trace()
        span = tracer.start_span(trace.id, type="llm_call")
        tracer.end_span(span.id, SpanOutput(content="done"))
        assert len(trace.spans) == 1

    def test_end_span_updates_token_totals(self, tracer):
        trace = tracer.start_trace()
        span = tracer.start_span(trace.id, type="llm_call", model="gpt-4o")
        tracer.end_span(span.id, input_tokens=100, output_tokens=50)
        assert trace.total_input_tokens == 100
        assert trace.total_output_tokens == 50

    def test_end_nonexistent_span_raises(self, tracer):
        with pytest.raises(KeyError):
            tracer.end_span("no-span")


class TestFlush:
    def test_flush_exports_buffered_traces(self, tracer, mock_exporter):
        trace = tracer.start_trace()
        tracer.end_trace(trace.id)
        tracer.flush()
        assert len(mock_exporter.all_traces) == 1

    def test_flush_clears_buffer(self, tracer):
        trace = tracer.start_trace()
        tracer.end_trace(trace.id)
        tracer.flush()
        assert len(tracer._buffer) == 0

    def test_flush_empty_buffer_no_op(self, tracer, mock_exporter):
        tracer.flush()
        assert mock_exporter.exported == []

    def test_flush_failure_restores_buffer(self, tracer, mock_exporter):
        mock_exporter.export = MagicMock(side_effect=RuntimeError("network error"))
        trace = tracer.start_trace()
        tracer.end_trace(trace.id)
        with pytest.raises(RuntimeError):
            tracer.flush()
        assert len(tracer._buffer) == 1

    def test_auto_flush_when_batch_full(self, mock_exporter):
        tracer = LanternTracer(
            service_name="svc",
            exporter=mock_exporter,
            batch_size=3,
            flush_interval=9999,
        )
        try:
            for _ in range(3):
                t = tracer.start_trace()
                tracer.end_trace(t.id)
            assert len(mock_exporter.all_traces) == 3
        finally:
            tracer._flush_timer.cancel()


class TestShutdown:
    def test_shutdown_flushes_and_calls_exporter(self, tracer, mock_exporter):
        trace = tracer.start_trace()
        tracer.end_trace(trace.id)
        tracer.shutdown()
        assert mock_exporter.shutdown_called
        assert len(mock_exporter.all_traces) == 1

    def test_shutdown_cancels_timer(self, tracer):
        tracer.shutdown()
        assert tracer._flush_timer is None
