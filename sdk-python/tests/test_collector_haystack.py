"""Tests for Haystack collector."""
from lantern_ai.collectors.haystack import create_lantern_haystack_handler
from .conftest import MockExporter
from lantern_ai.tracer import LanternTracer


def _make_tracer(mock_exporter):
    t = LanternTracer(service_name="svc", exporter=mock_exporter, flush_interval=9999)
    t._flush_timer.cancel()
    return t


class TestHaystackHandler:
    def test_creates_handler_object(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer)
        assert handler is not None
        assert hasattr(handler, "on_pipeline_start")
        assert hasattr(handler, "on_component_start")
        assert hasattr(handler, "on_llm_start")

    def test_pipeline_start_creates_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer)
        span_id = handler.on_pipeline_start(pipeline_name="rag_pipeline")
        assert span_id is not None
        assert len(tracer._traces) > 0

    def test_pipeline_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer)
        handler.on_pipeline_start(pipeline_name="rag_pipeline")
        handler.on_pipeline_end(pipeline_name="rag_pipeline", output="done")
        handler.finish()
        tracer.flush()

        assert len(mock_exporter.all_traces) == 1
        trace = mock_exporter.all_traces[0]
        custom_spans = [s for s in trace.spans if s.type == "custom"]
        assert len(custom_spans) == 1

    def test_retriever_component_gets_retrieval_type(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer)
        handler.on_component_start(component_name="bm25_retriever", component_type="BM25Retriever")
        handler.on_component_end(component_name="bm25_retriever", output="3 docs")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        retrieval_spans = [s for s in trace.spans if s.type == "retrieval"]
        assert len(retrieval_spans) == 1

    def test_non_retriever_component_gets_custom_type(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer)
        handler.on_component_start(component_name="prompt_builder", component_type="PromptBuilder")
        handler.on_component_end(component_name="prompt_builder", output="built prompt")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        custom_spans = [s for s in trace.spans if s.type == "custom"]
        assert len(custom_spans) == 1

    def test_llm_lifecycle_records_span(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer)
        span_id = handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "hi"}])
        handler.on_llm_end(span_id, output="hello", input_tokens=5, output_tokens=3)
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        llm_spans = [s for s in trace.spans if s.type == "llm_call"]
        assert len(llm_spans) == 1

    def test_custom_agent_name(self):
        mock_exporter = MockExporter()
        tracer = _make_tracer(mock_exporter)
        handler = create_lantern_haystack_handler(tracer, agent_name="my-haystack")
        handler.on_pipeline_start(pipeline_name="p1")
        handler.on_pipeline_end(pipeline_name="p1")
        handler.finish()
        tracer.flush()

        trace = mock_exporter.all_traces[0]
        assert trace.agent_name == "my-haystack"
