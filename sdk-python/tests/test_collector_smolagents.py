"""Tests for Smolagents collector."""
from lantern_ai.collectors.smolagents import create_lantern_smolagents_handler
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter):
    t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
    t._flush_timer.cancel()
    return t


class TestSmolagentsHandler:
    def test_creates_handler_object(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_smolagents_handler(tracer)
        assert handler is not None
        assert hasattr(handler, "on_step_start")
        assert hasattr(handler, "on_llm_call")
        assert hasattr(handler, "on_tool_start")

    def test_step_start_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_smolagents_handler(tracer)
        span_id = handler.on_step_start(step_name="think", step_number=1)
        assert span_id is not None
        assert len(tracer._traces) > 0

    def test_step_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_smolagents_handler(tracer)
        handler.on_step_start(step_name="think", step_number=1)
        handler.on_step_end(step_number=1, output="thought complete")
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        step_spans = [s for s in trace.spans if s.type == "reasoning_step"]
        assert len(step_spans) == 1

    def test_llm_call_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_smolagents_handler(tracer)
        span_id = handler.on_llm_call(model="gpt-4", messages=[{"role": "user", "content": "hi"}])
        handler.on_llm_end(span_id, output="hello", input_tokens=5, output_tokens=3)
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1
        assert trace.total_input_tokens == 5

    def test_tool_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_smolagents_handler(tracer)
        span_id = handler.on_tool_start(tool_name="web_search", args={"query": "test"})
        handler.on_tool_end(span_id, output="results")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        tool_spans = [s for s in trace.spans if s.type == "tool_call"]
        assert len(tool_spans) == 1
        assert tool_spans[0].tool_name == "web_search"

    def test_custom_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_smolagents_handler(tracer, agent_name="my-smol")
        handler.on_step_start(step_name="s1", step_number=1)
        handler.on_step_end(step_number=1, output="done")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.agent_name == "my-smol"
