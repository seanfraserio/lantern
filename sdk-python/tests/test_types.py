"""Tests for Lantern types — camelCase serialization and field presence."""

import pytest
from lantern_ai.types import (
    Span,
    SpanInput,
    SpanOutput,
    EvalScore,
    Trace,
    TraceSource,
)


class TestSpanInputDict:
    def test_messages_key(self):
        s = SpanInput(messages=[{"role": "user", "content": "hi"}])
        d = s.to_dict()
        assert "messages" in d
        assert d["messages"] == [{"role": "user", "content": "hi"}]

    def test_empty_omits_keys(self):
        d = SpanInput().to_dict()
        assert d == {}

    def test_prompt_key(self):
        d = SpanInput(prompt="hello").to_dict()
        assert d == {"prompt": "hello"}

    def test_args_key(self):
        d = SpanInput(args={"x": 1}).to_dict()
        assert d == {"args": {"x": 1}}


class TestSpanOutputDict:
    def test_tool_calls_camel(self):
        d = SpanOutput(tool_calls=[{"name": "search"}]).to_dict()
        assert "toolCalls" in d
        assert "tool_calls" not in d

    def test_stop_reason_camel(self):
        d = SpanOutput(stop_reason="end_turn").to_dict()
        assert "stopReason" in d
        assert "stop_reason" not in d

    def test_content_present(self):
        d = SpanOutput(content="result").to_dict()
        assert d["content"] == "result"

    def test_empty_omits_keys(self):
        assert SpanOutput().to_dict() == {}


class TestTraceSourceDict:
    def test_service_name_camel(self):
        ts = TraceSource(service_name="svc")
        d = ts.to_dict()
        assert "serviceName" in d
        assert d["serviceName"] == "svc"

    def test_sdk_version_camel(self):
        ts = TraceSource(service_name="svc", sdk_version="0.1.0")
        d = ts.to_dict()
        assert "sdkVersion" in d

    def test_exporter_type_camel(self):
        ts = TraceSource(service_name="svc", exporter_type="console")
        d = ts.to_dict()
        assert "exporterType" in d


class TestSpanDict:
    def test_required_camel_keys(self):
        span = Span(trace_id="trace-1")
        d = span.to_dict()
        assert "id" in d
        assert "traceId" in d
        assert d["traceId"] == "trace-1"
        assert "type" in d
        assert "startTime" in d
        assert "input" in d

    def test_optional_camel_keys(self):
        span = Span(
            trace_id="t",
            parent_span_id="parent",
            end_time=1000.0,
            duration_ms=10.0,
            model="gpt-4",
            input_tokens=5,
            output_tokens=10,
            estimated_cost_usd=0.001,
            tool_name="search",
            tool_result={"hits": 3},
            error="oops",
        )
        d = span.to_dict()
        assert "parentSpanId" in d
        assert "endTime" in d
        assert "durationMs" in d
        assert "model" in d
        assert "inputTokens" in d
        assert "outputTokens" in d
        assert "estimatedCostUsd" in d
        assert "toolName" in d
        assert "toolResult" in d
        assert "error" in d

    def test_snake_case_keys_absent(self):
        span = Span(
            trace_id="t",
            parent_span_id="p",
            input_tokens=1,
            output_tokens=2,
        )
        d = span.to_dict()
        for key in d:
            assert "_" not in key or key == "id", f"Unexpected snake_case key: {key}"


class TestTraceDict:
    def test_required_camel_keys(self):
        t = Trace(agent_name="my-agent")
        d = t.to_dict()
        for key in ("id", "sessionId", "agentName", "environment", "startTime",
                    "status", "spans", "metadata", "totalInputTokens",
                    "totalOutputTokens", "estimatedCostUsd"):
            assert key in d, f"Missing key: {key}"

    def test_agent_name_camel(self):
        t = Trace(agent_name="bot")
        assert t.to_dict()["agentName"] == "bot"

    def test_spans_serialized(self):
        from lantern_ai.types import Span
        t = Trace(agent_name="a")
        t.spans.append(Span(trace_id=t.id))
        d = t.to_dict()
        assert isinstance(d["spans"], list)
        assert len(d["spans"]) == 1


class TestEvalScoreDict:
    def test_required_fields(self):
        es = EvalScore(scorer="quality", score=0.9)
        d = es.to_dict()
        assert d["scorer"] == "quality"
        assert d["score"] == 0.9

    def test_optional_fields(self):
        es = EvalScore(scorer="s", score=1.0, label="good", detail="looks great")
        d = es.to_dict()
        assert d["label"] == "good"
        assert d["detail"] == "looks great"
