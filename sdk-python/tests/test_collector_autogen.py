"""Tests for AutoGen collector."""
from lantern_ai.collectors.autogen import create_lantern_autogen_handler
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter):
    t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
    t._flush_timer.cancel()
    return t


class TestAutoGenHandler:
    def test_creates_handler_object(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_autogen_handler(tracer)
        assert handler is not None
        assert hasattr(handler, "on_message")
        assert hasattr(handler, "on_llm_start")
        assert hasattr(handler, "on_tool_start")

    def test_message_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_autogen_handler(tracer)
        span_id = handler.on_message(sender="user_proxy", recipient="assistant", content="hello")
        assert span_id is not None
        assert len(tracer._traces) > 0

    def test_message_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_autogen_handler(tracer)
        span_id = handler.on_message(sender="user_proxy", recipient="assistant", content="hello")
        handler.on_message_end(span_id, output="response")
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        custom_spans = [s for s in trace.spans if s.type == "custom"]
        assert len(custom_spans) == 1

    def test_llm_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_autogen_handler(tracer)
        span_id = handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "hi"}])
        handler.on_llm_end(span_id, output="hello", input_tokens=8, output_tokens=4)
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1
        assert trace.total_input_tokens == 8

    def test_tool_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_autogen_handler(tracer)
        span_id = handler.on_tool_start(tool_name="code_exec", args={"code": "print(1)"})
        handler.on_tool_end(span_id, output="1")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        tool_spans = [s for s in trace.spans if s.type == "tool_call"]
        assert len(tool_spans) == 1
        assert tool_spans[0].tool_name == "code_exec"

    def test_custom_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_autogen_handler(tracer, agent_name="my-autogen")
        handler.on_llm_start(model="gpt-4", messages=[])
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.agent_name == "my-autogen"
