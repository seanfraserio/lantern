"""Tests for CrewAI collector."""
import pytest
from unittest.mock import MagicMock, patch

from lantern_ai.collectors.crewai import create_lantern_crewai_handler
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter):
    t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
    t._flush_timer.cancel()
    return t


class TestCrewAIHandler:
    def test_creates_handler_object(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer)
        assert handler is not None
        assert hasattr(handler, "on_task_start")
        assert hasattr(handler, "on_task_end")

    def test_task_start_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer)
        handler.on_task_start(task_name="research", agent_name="researcher")
        # Verify a trace was started
        assert len(tracer._traces) > 0

    def test_task_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer)
        handler.on_task_start(task_name="research", agent_name="researcher")
        handler.on_task_end(task_name="research", output="Found results")
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        assert trace.status == "success"
        custom_spans = [s for s in trace.spans if s.type == "custom"]
        assert len(custom_spans) == 1

    def test_llm_start_end_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer)
        span_id = handler.on_llm_start(
            model="gpt-4",
            messages=[{"role": "user", "content": "hello"}],
        )
        handler.on_llm_end(span_id, output="world", input_tokens=5, output_tokens=3)
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1
        assert trace.total_input_tokens == 5
        assert trace.total_output_tokens == 3

    def test_tool_start_end_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer)
        span_id = handler.on_tool_start(tool_name="search", args={"query": "test"})
        handler.on_tool_end(span_id, output="results")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        tool_spans = [s for s in trace.spans if s.type == "tool_call"]
        assert len(tool_spans) == 1
        assert tool_spans[0].tool_name == "search"

    def test_finish_ends_trace(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer)
        handler.on_task_start(task_name="task1", agent_name="agent1")
        handler.on_task_end(task_name="task1", output="done")
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        assert mock_exporter.all_traces[0].status == "success"
        # Trace id should be reset
        assert handler._trace_id is None

    def test_custom_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_crewai_handler(tracer, agent_name="my-crew")
        handler.on_task_start(task_name="task1", agent_name="agent1")
        handler.on_task_end(task_name="task1", output="done")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.agent_name == "my-crew"
