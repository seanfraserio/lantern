"""Tests for AgentSpan creation, timing, and context-manager behaviour."""

import time
import pytest
from lantern_ai.span import AgentSpan, estimate_cost
from lantern_ai.types import SpanInput, SpanOutput


class TestEstimateCost:
    def test_known_model(self):
        cost = estimate_cost("gpt-4o", 1000, 500)
        assert cost == pytest.approx(0.005 + 0.0075, rel=1e-6)

    def test_unknown_model_fallback(self):
        cost = estimate_cost("unknown-model", 1000, 1000)
        assert cost > 0

    def test_zero_tokens(self):
        assert estimate_cost("gpt-4o", 0, 0) == 0.0


class TestAgentSpanCreation:
    def test_basic_properties(self):
        span = AgentSpan(trace_id="trace-1", type="llm_call")
        assert span.trace_id == "trace-1"
        assert span.id  # non-empty UUID
        assert span._span.type == "llm_call"

    def test_model_tool_name(self):
        span = AgentSpan(trace_id="t", type="tool_call", model="gpt-4o", tool_name="search")
        assert span._span.model == "gpt-4o"
        assert span._span.tool_name == "search"

    def test_parent_span_id(self):
        span = AgentSpan(trace_id="t", type="custom", parent_span_id="parent-123")
        assert span._span.parent_span_id == "parent-123"

    def test_initial_input(self):
        inp = SpanInput(prompt="hello")
        span = AgentSpan(trace_id="t", type="llm_call", input=inp)
        assert span._span.input.prompt == "hello"


class TestAgentSpanSetters:
    def test_set_input(self):
        span = AgentSpan(trace_id="t", type="llm_call")
        span.set_input(messages=[{"role": "user", "content": "hi"}])
        assert span._span.input.messages == [{"role": "user", "content": "hi"}]

    def test_set_output(self):
        span = AgentSpan(trace_id="t", type="llm_call")
        span.set_output(content="result", stop_reason="end_turn")
        assert span._span.output is not None
        assert span._span.output.content == "result"
        assert span._span.output.stop_reason == "end_turn"

    def test_set_tokens_computes_cost(self):
        span = AgentSpan(trace_id="t", type="llm_call", model="gpt-4o")
        span.set_tokens(1000, 500)
        assert span._span.input_tokens == 1000
        assert span._span.output_tokens == 500
        assert span._span.estimated_cost_usd is not None
        assert span._span.estimated_cost_usd > 0

    def test_set_tokens_no_cost_without_model(self):
        span = AgentSpan(trace_id="t", type="llm_call")
        span.set_tokens(1000, 500)
        assert span._span.estimated_cost_usd is None

    def test_set_error(self):
        span = AgentSpan(trace_id="t", type="llm_call")
        span.set_error("something went wrong")
        assert span._span.error == "something went wrong"


class TestAgentSpanEnd:
    def test_end_sets_timing(self):
        span = AgentSpan(trace_id="t", type="custom")
        completed = span.end()
        assert completed.end_time is not None
        assert completed.duration_ms is not None
        assert completed.duration_ms >= 0

    def test_end_with_output(self):
        span = AgentSpan(trace_id="t", type="llm_call")
        out = SpanOutput(content="done")
        completed = span.end(output=out)
        assert completed.output is not None
        assert completed.output.content == "done"

    def test_end_with_tokens_and_model(self):
        span = AgentSpan(trace_id="t", type="llm_call", model="gpt-4o")
        completed = span.end(input_tokens=100, output_tokens=50)
        assert completed.input_tokens == 100
        assert completed.output_tokens == 50
        assert completed.estimated_cost_usd is not None

    def test_end_with_error(self):
        span = AgentSpan(trace_id="t", type="llm_call")
        completed = span.end(error="API timeout")
        assert completed.error == "API timeout"

    def test_to_span_snapshot(self):
        span = AgentSpan(trace_id="t", type="custom")
        snapshot = span.to_span()
        assert snapshot.id == span.id
        assert snapshot is not span._span


class TestAgentSpanContextManager:
    def test_context_manager_ends_span(self):
        with AgentSpan(trace_id="t", type="custom") as span:
            span.set_output(content="result")
        assert span._span.end_time is not None

    def test_context_manager_captures_exception(self):
        with pytest.raises(ValueError):
            with AgentSpan(trace_id="t", type="custom") as span:
                raise ValueError("test error")
        assert span._span.error == "test error"
        assert span._span.end_time is not None

    def test_context_manager_returns_self(self):
        span = AgentSpan(trace_id="t", type="custom")
        with span as s:
            assert s is span
