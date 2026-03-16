"""Tests for ConsoleExporter — stdout output."""

import sys
import io
import pytest
from lantern_ai.exporters.console import ConsoleExporter
from lantern_ai.types import Trace, Span


def _make_trace(agent_name="test-bot", status="success", **kwargs) -> Trace:
    t = Trace(agent_name=agent_name, status=status, **kwargs)
    t.end_time = t.start_time + 1000
    t.duration_ms = 1000
    return t


def _make_span(trace_id: str, span_type="llm_call", model=None) -> Span:
    s = Span(trace_id=trace_id, type=span_type, model=model)
    s.end_time = s.start_time + 100
    s.duration_ms = 100
    return s


class TestConsoleExporterBasic:
    def test_exporter_type(self):
        exp = ConsoleExporter()
        assert exp.exporter_type == "console"

    def test_export_empty_no_output(self, capsys):
        exp = ConsoleExporter(use_color=False)
        exp.export([])
        captured = capsys.readouterr()
        assert captured.out == ""

    def test_export_prints_trace_id(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace()
        exp.export([trace])
        captured = capsys.readouterr()
        assert trace.id in captured.out

    def test_export_prints_agent_name(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace(agent_name="my-agent")
        exp.export([trace])
        captured = capsys.readouterr()
        assert "my-agent" in captured.out

    def test_export_prints_duration(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace()
        exp.export([trace])
        captured = capsys.readouterr()
        assert "1000ms" in captured.out

    def test_export_prints_token_counts(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace()
        trace.total_input_tokens = 42
        trace.total_output_tokens = 17
        exp.export([trace])
        captured = capsys.readouterr()
        assert "42" in captured.out
        assert "17" in captured.out

    def test_export_prints_cost(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace()
        trace.estimated_cost_usd = 0.001234
        exp.export([trace])
        captured = capsys.readouterr()
        assert "$" in captured.out

    def test_export_prints_span_count(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace()
        trace.spans.append(_make_span(trace.id))
        exp.export([trace])
        captured = capsys.readouterr()
        assert "Spans: 1" in captured.out


class TestConsoleExporterVerbose:
    def test_verbose_prints_span_type(self, capsys):
        exp = ConsoleExporter(verbose=True, use_color=False)
        trace = _make_trace()
        span = _make_span(trace.id, span_type="llm_call", model="gpt-4o")
        trace.spans.append(span)
        exp.export([trace])
        captured = capsys.readouterr()
        assert "llm_call" in captured.out

    def test_verbose_prints_model(self, capsys):
        exp = ConsoleExporter(verbose=True, use_color=False)
        trace = _make_trace()
        span = _make_span(trace.id, model="gpt-4o")
        trace.spans.append(span)
        exp.export([trace])
        captured = capsys.readouterr()
        assert "gpt-4o" in captured.out

    def test_non_verbose_no_span_detail(self, capsys):
        exp = ConsoleExporter(verbose=False, use_color=False)
        trace = _make_trace()
        span = _make_span(trace.id, model="gpt-4o")
        trace.spans.append(span)
        exp.export([trace])
        captured = capsys.readouterr()
        assert "gpt-4o" not in captured.out


class TestConsoleExporterAsync:
    @pytest.mark.asyncio
    async def test_export_async_delegates_to_sync(self, capsys):
        exp = ConsoleExporter(use_color=False)
        trace = _make_trace(agent_name="async-bot")
        await exp.export_async([trace])
        captured = capsys.readouterr()
        assert "async-bot" in captured.out
