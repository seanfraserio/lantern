"""Data types for Lantern traces and spans.

All types use camelCase keys in their serialized form to match the
Lantern ingest API. The Python-side fields use snake_case per PEP 8.
"""

from __future__ import annotations

import uuid
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence


# ---------------------------------------------------------------------------
# Span types
# ---------------------------------------------------------------------------

SpanType = str  # "llm_call" | "tool_call" | "reasoning_step" | "retrieval" | "custom"
TraceStatus = str  # "running" | "success" | "error"


@dataclass
class SpanInput:
    """Input payload attached to a span."""

    messages: Optional[List[Dict[str, str]]] = None
    prompt: Optional[str] = None
    args: Optional[Any] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {}
        if self.messages is not None:
            d["messages"] = self.messages
        if self.prompt is not None:
            d["prompt"] = self.prompt
        if self.args is not None:
            d["args"] = self.args
        return d


@dataclass
class SpanOutput:
    """Output payload attached to a span."""

    content: Optional[str] = None
    tool_calls: Optional[List[Any]] = None
    stop_reason: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {}
        if self.content is not None:
            d["content"] = self.content
        if self.tool_calls is not None:
            d["toolCalls"] = self.tool_calls
        if self.stop_reason is not None:
            d["stopReason"] = self.stop_reason
        return d


@dataclass
class EvalScore:
    """A single evaluation score attached to a trace."""

    scorer: str
    score: float
    label: Optional[str] = None
    detail: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"scorer": self.scorer, "score": self.score}
        if self.label is not None:
            d["label"] = self.label
        if self.detail is not None:
            d["detail"] = self.detail
        return d


@dataclass
class TraceSource:
    """Identifies the source that produced a trace."""

    service_name: str
    sdk_version: Optional[str] = None
    exporter_type: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {"serviceName": self.service_name}
        if self.sdk_version is not None:
            d["sdkVersion"] = self.sdk_version
        if self.exporter_type is not None:
            d["exporterType"] = self.exporter_type
        return d


# ---------------------------------------------------------------------------
# Span
# ---------------------------------------------------------------------------


@dataclass
class Span:
    """A single step within an agent trace."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    trace_id: str = ""
    parent_span_id: Optional[str] = None
    type: SpanType = "custom"
    start_time: float = field(default_factory=lambda: time.time() * 1000)
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    input: SpanInput = field(default_factory=SpanInput)
    output: Optional[SpanOutput] = None
    model: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    estimated_cost_usd: Optional[float] = None
    tool_name: Optional[str] = None
    tool_result: Optional[Any] = None
    error: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "id": self.id,
            "traceId": self.trace_id,
            "type": self.type,
            "startTime": self.start_time,
            "input": self.input.to_dict(),
        }
        if self.parent_span_id is not None:
            d["parentSpanId"] = self.parent_span_id
        if self.end_time is not None:
            d["endTime"] = self.end_time
        if self.duration_ms is not None:
            d["durationMs"] = self.duration_ms
        if self.output is not None:
            d["output"] = self.output.to_dict()
        if self.model is not None:
            d["model"] = self.model
        if self.input_tokens is not None:
            d["inputTokens"] = self.input_tokens
        if self.output_tokens is not None:
            d["outputTokens"] = self.output_tokens
        if self.estimated_cost_usd is not None:
            d["estimatedCostUsd"] = self.estimated_cost_usd
        if self.tool_name is not None:
            d["toolName"] = self.tool_name
        if self.tool_result is not None:
            d["toolResult"] = self.tool_result
        if self.error is not None:
            d["error"] = self.error
        return d


# ---------------------------------------------------------------------------
# Trace
# ---------------------------------------------------------------------------


@dataclass
class Trace:
    """One complete agent execution."""

    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    agent_name: str = ""
    agent_version: Optional[str] = None
    environment: str = "production"
    start_time: float = field(default_factory=lambda: time.time() * 1000)
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    status: TraceStatus = "running"
    spans: List[Span] = field(default_factory=list)
    metadata: Dict[str, Any] = field(default_factory=dict)
    source: Optional[TraceSource] = None
    scores: Optional[List[EvalScore]] = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    estimated_cost_usd: float = 0.0

    def to_dict(self) -> Dict[str, Any]:
        d: Dict[str, Any] = {
            "id": self.id,
            "sessionId": self.session_id,
            "agentName": self.agent_name,
            "environment": self.environment,
            "startTime": self.start_time,
            "status": self.status,
            "spans": [s.to_dict() for s in self.spans],
            "metadata": self.metadata,
            "totalInputTokens": self.total_input_tokens,
            "totalOutputTokens": self.total_output_tokens,
            "estimatedCostUsd": self.estimated_cost_usd,
        }
        if self.agent_version is not None:
            d["agentVersion"] = self.agent_version
        if self.end_time is not None:
            d["endTime"] = self.end_time
        if self.duration_ms is not None:
            d["durationMs"] = self.duration_ms
        if self.source is not None:
            d["source"] = self.source.to_dict()
        if self.scores is not None:
            d["scores"] = [s.to_dict() for s in self.scores]
        return d
