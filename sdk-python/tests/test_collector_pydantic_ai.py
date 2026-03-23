"""Tests for Pydantic AI collector."""
from lantern_ai.collectors.pydantic_ai import create_lantern_pydantic_handler
from lantern_ai.types import SpanOutput
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter):
    t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
    t._flush_timer.cancel()
    return t


class TestPydanticAIHandler:
    def test_creates_handler_object(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_pydantic_handler(tracer)
        assert handler is not None
        assert hasattr(handler, "on_llm_start")
        assert hasattr(handler, "on_tool_start")
        assert hasattr(handler, "on_step")

    def test_llm_start_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_pydantic_handler(tracer)
        span_id = handler.on_llm_start(
            model="gpt-4",
            messages=[{"role": "user", "content": "hello"}],
        )
        assert span_id is not None
        assert len(tracer._traces) > 0

    def test_llm_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_pydantic_handler(tracer)
        span_id = handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "hi"}])
        handler.on_llm_end(span_id, output="hello", input_tokens=10, output_tokens=5)
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1
        assert trace.total_input_tokens == 10

    def test_tool_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_pydantic_handler(tracer)
        span_id = handler.on_tool_start(tool_name="calculator", args={"x": 1})
        handler.on_tool_end(span_id, output="2")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        tool_spans = [s for s in trace.spans if s.type == "tool_call"]
        assert len(tool_spans) == 1
        assert tool_spans[0].tool_name == "calculator"

    def test_on_step_creates_reasoning_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_pydantic_handler(tracer)
        span_id = handler.on_step(step_name="validate input")
        assert span_id is not None
        # End the span before finishing the trace
        tracer.end_span(span_id, SpanOutput(content="step done"))
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        step_spans = [s for s in trace.spans if s.type == "reasoning_step"]
        assert len(step_spans) == 1

    def test_custom_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_pydantic_handler(tracer, agent_name="my-pydantic")
        handler.on_llm_start(model="gpt-4", messages=[])
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.agent_name == "my-pydantic"
