"""Tests for DSPy collector."""
from lantern_ai.collectors.dspy import create_lantern_dspy_handler
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter):
    t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
    t._flush_timer.cancel()
    return t


class TestDSPyHandler:
    def test_creates_handler_object(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_dspy_handler(tracer)
        assert handler is not None
        assert hasattr(handler, "on_predict_start")
        assert hasattr(handler, "on_llm_start")
        assert hasattr(handler, "on_retriever_start")

    def test_predict_start_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_dspy_handler(tracer)
        span_id = handler.on_predict_start(module_name="ChainOfThought", inputs={"question": "what?"})
        assert span_id is not None
        assert len(tracer._traces) > 0

    def test_predict_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_dspy_handler(tracer)
        handler.on_predict_start(module_name="ChainOfThought", inputs={"question": "what?"})
        handler.on_predict_end(module_name="ChainOfThought", output="answer")
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        custom_spans = [s for s in trace.spans if s.type == "custom"]
        assert len(custom_spans) == 1

    def test_llm_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_dspy_handler(tracer)
        span_id = handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "hi"}])
        handler.on_llm_end(span_id, output="hello", input_tokens=10, output_tokens=5)
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1
        assert trace.total_input_tokens == 10

    def test_retriever_creates_retrieval_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_dspy_handler(tracer)
        span_id = handler.on_retriever_start(query="search term")
        handler.on_retriever_end(span_id, output="3 passages")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        retrieval_spans = [s for s in trace.spans if s.type == "retrieval"]
        assert len(retrieval_spans) == 1

    def test_custom_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_dspy_handler(tracer, agent_name="my-dspy")
        handler.on_predict_start(module_name="M")
        handler.on_predict_end(module_name="M", output="done")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.agent_name == "my-dspy"
