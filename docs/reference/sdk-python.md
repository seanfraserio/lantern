# Python SDK Reference

Reference for `lantern-ai`, the Python SDK for Lantern agent observability.
The SDK provides trace and span management, multiple exporters, and
auto-instrumentation wrappers for Anthropic and OpenAI clients.

**Package:** `lantern-ai`
**Source:** `sdk-python/`

---

## LanternTracer

The core tracer class. Manages traces and spans, buffers completed traces, and
exports them via the configured exporter. Thread-safe -- all internal state is
protected by a lock.

### Constructor

```python
from lantern_ai import LanternTracer
from lantern_ai.exporters.lantern import LanternExporter

tracer = LanternTracer(
    service_name="my-service",
    agent_name="my-agent",
    environment="production",
    exporter=LanternExporter(endpoint="https://ingest.openlanternai.com", api_key="ltn_..."),
    batch_size=50,
    flush_interval=5.0,
)
```

Alternatively, provide `api_key` and `endpoint` instead of `exporter` to have
a `LanternExporter` created automatically:

```python
tracer = LanternTracer(
    service_name="my-service",
    api_key="ltn_abc123...",
    endpoint="https://ingest.openlanternai.com",
)
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `service_name` | str | `"unknown"` | Logical name of the service |
| `agent_name` | str | `"default-agent"` | Default agent name |
| `agent_version` | str or None | `None` | Agent version string |
| `environment` | str | `"production"` | Deployment environment |
| `exporter` | `TraceExporter` or None | `None` | Custom exporter instance |
| `api_key` | str or None | `None` | API key (creates `LanternExporter` if `exporter` is None) |
| `endpoint` | str or None | `None` | Ingest URL (creates `LanternExporter` if `exporter` is None) |
| `batch_size` | int | `50` | Buffer size before auto-flush |
| `flush_interval` | float | `5.0` | Seconds between periodic background flushes |

Raises `ValueError` if neither `exporter` nor both `api_key` and `endpoint`
are provided.

The constructor starts a daemon thread for periodic flushing that does not
prevent process exit.

### Methods

#### `start_trace(agent_name=None, *, agent_version=None, session_id=None, environment=None, metadata=None) -> Trace`

Start a new trace for an agent execution.

```python
trace = tracer.start_trace(
    agent_name="my-agent",
    session_id="custom-session-id",
    metadata={"user_id": "user-123"},
)
```

| Parameter | Type | Default | Description |
|---|---|---|---|
| `agent_name` | str or None | Uses tracer default | Agent name |
| `agent_version` | str or None | Uses tracer default | Agent version |
| `session_id` | str or None | Auto-generated UUID | Session identifier |
| `environment` | str or None | Uses tracer default | Environment override |
| `metadata` | dict or None | `{}` | Arbitrary metadata |

#### `end_trace(trace_id: str, status: TraceStatus = "success") -> None`

Finalise a trace and move it into the export buffer. Triggers auto-flush if the
buffer reaches `batch_size`.

```python
tracer.end_trace(trace.id, "success")
```

Raises `KeyError` if `trace_id` is not found.

#### `get_trace(trace_id: str) -> Trace | None`

Return a trace by ID for inspection, or `None` if not found.

#### `start_span(trace_id, *, type, model=None, tool_name=None, parent_span_id=None, input=None) -> AgentSpan`

Start a new span within a trace. Returns an `AgentSpan` instance.

```python
span = tracer.start_span(
    trace.id,
    type="llm_call",
    input=SpanInput(messages=[{"role": "user", "content": "Hello"}]),
    model="claude-sonnet-4-5-20251001",
)
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `trace_id` | str | Yes | Parent trace UUID |
| `type` | str | Yes | Span type (see Span Types) |
| `model` | str or None | No | Model identifier |
| `tool_name` | str or None | No | Tool name |
| `parent_span_id` | str or None | No | Parent span UUID |
| `input` | `SpanInput` or None | No | Input payload |

Raises `KeyError` if `trace_id` is not found.

#### `end_span(span_id, output=None, *, input_tokens=None, output_tokens=None, error=None) -> None`

End an active span with its output and record it on the trace.

```python
tracer.end_span(
    span.id,
    SpanOutput(content="Hello! How can I help?"),
    input_tokens=10,
    output_tokens=25,
)
```

Raises `KeyError` if `span_id` is not found or already ended.

#### `flush() -> None`

Flush all buffered traces to the exporter synchronously. If the export fails,
traces are returned to the buffer.

#### `flush_async() -> None`

Async variant of `flush()`. Uses the exporter's `export_async()` method.

```python
await tracer.flush_async()
```

#### `shutdown() -> None`

Flush remaining traces, stop the periodic timer, and close the exporter.

```python
tracer.shutdown()
```

#### `shutdown_async() -> None`

Async variant of `shutdown()`.

```python
await tracer.shutdown_async()
```

---

## AgentSpan

Builder and context manager for a single span within a trace. Created by
`LanternTracer.start_span()`.

### Properties

| Property | Type | Description |
|---|---|---|
| `id` | str | Span UUID |
| `trace_id` | str | Parent trace UUID |

### Methods

#### `set_input(*, messages=None, prompt=None, args=None) -> None`

Set the input payload for this span.

```python
span.set_input(messages=[{"role": "user", "content": "Hello"}])
```

#### `set_output(*, content=None, tool_calls=None, stop_reason=None) -> None`

Set the output payload for this span.

```python
span.set_output(content="Hello! How can I help?", stop_reason="end_turn")
```

#### `set_tokens(input_tokens: int, output_tokens: int) -> None`

Record token usage and compute estimated cost (if model is set).

```python
span.set_tokens(10, 25)
```

#### `set_error(error_message: str) -> None`

Record an error message on this span.

```python
span.set_error("API rate limit exceeded")
```

#### `end(output=None, *, input_tokens=None, output_tokens=None, error=None) -> Span`

Finalise the span. Sets `end_time`, computes `duration_ms`, applies token
counts, and calculates cost estimation. Returns the finalised `Span` dataclass.

```python
completed_span = span.end(
    output=SpanOutput(content="Done"),
    input_tokens=10,
    output_tokens=20,
)
```

#### `to_span() -> Span`

Return a snapshot copy of the underlying `Span` dataclass.

### Context Manager

`AgentSpan` can be used as a context manager. The span is automatically ended
when the block exits. If an exception occurs, the error is recorded.

```python
with AgentSpan(trace_id=trace.id, type="llm_call", model="gpt-4o") as span:
    span.set_input(messages=[{"role": "user", "content": "Hello"}])
    # ... do work ...
    span.set_output(content="Response")
    span.set_tokens(10, 25)
# span.end() is called automatically
```

---

## Exporters

All exporters inherit from the `TraceExporter` abstract base class:

```python
from abc import ABC, abstractmethod
from typing import List
from lantern_ai.types import Trace

class TraceExporter(ABC):
    @property
    @abstractmethod
    def exporter_type(self) -> str: ...

    @abstractmethod
    def export(self, traces: List[Trace]) -> None: ...

    def export_async(self, traces: List[Trace]): ...   # defaults to sync
    def shutdown(self) -> None: ...
    async def shutdown_async(self) -> None: ...
```

### LanternExporter

Exports traces to a Lantern ingest backend via HTTP POST using `httpx`.
Supports exponential-backoff retry on 5xx and network errors.

```python
from lantern_ai.exporters.lantern import LanternExporter

exporter = LanternExporter(
    endpoint="https://ingest.openlanternai.com",
    api_key="ltn_abc123...",
    max_retries=3,
    retry_base_delay=1.0,
)
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `endpoint` | str | -- | **Required.** Base URL of the ingest server |
| `api_key` | str or None | `None` | Bearer token for authentication |
| `max_retries` | int | `3` | Number of retries on transient failures |
| `retry_base_delay` | float | `1.0` | Base delay in seconds for exponential backoff |

**Methods:**

| Method | Description |
|---|---|
| `export(traces)` | Synchronous export via `httpx.Client` |
| `export_async(traces)` | Async export via `httpx.AsyncClient` |
| `shutdown()` | Close the sync HTTP client |
| `shutdown_async()` | Close both async and sync clients |

**Retry behaviour:**

- Retries on HTTP 5xx responses
- Retries on connection errors
- Exponential backoff: delay * 2^attempt
- HTTP client timeout: 30 seconds

### ConsoleExporter

Exports traces to stdout with optional per-span detail and ANSI colour output.

```python
from lantern_ai.exporters.console import ConsoleExporter

exporter = ConsoleExporter(verbose=True, use_color=True)
```

**Parameters:**

| Parameter | Type | Default | Description |
|---|---|---|---|
| `verbose` | bool | `False` | Print individual span details |
| `use_color` | bool | `True` | Use ANSI colour codes (auto-detected based on TTY) |

---

## Auto-instrumentation Wrappers

### wrap_anthropic_client(client, tracer, *, trace_id=None, agent_name=None)

Monkey-patches an Anthropic client's `messages.create()` method to
automatically create `llm_call` spans. Works with both sync (`Anthropic`) and
async (`AsyncAnthropic`) clients.

```python
from anthropic import Anthropic
from lantern_ai import LanternTracer, wrap_anthropic_client

tracer = LanternTracer(...)
client = Anthropic()
wrap_anthropic_client(client, tracer)

# All client.messages.create() calls are now traced
response = client.messages.create(
    model="claude-sonnet-4-5-20251001",
    max_tokens=1024,
    messages=[{"role": "user", "content": "Hello"}],
)
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `client` | Anthropic client | The client instance to wrap (mutated in place) |
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `trace_id` | str or None | Existing trace to add spans to |
| `agent_name` | str or None | Agent name for auto-created traces (default `"anthropic-agent"`) |

**What it captures:**

- Input messages (flattened content blocks to text)
- Text output content
- Tool use blocks (as child `tool_call` spans)
- Stop reason
- Token usage (`input_tokens`, `output_tokens` from response usage)
- Errors (span and trace marked as error)

Returns the same client instance.

---

### wrap_openai_client(client, tracer, *, trace_id=None, agent_name=None)

Monkey-patches an OpenAI client's `chat.completions.create()` method. Works
with both sync (`OpenAI`) and async (`AsyncOpenAI`) clients.

```python
from openai import OpenAI
from lantern_ai import LanternTracer, wrap_openai_client

tracer = LanternTracer(...)
client = OpenAI()
wrap_openai_client(client, tracer)

# All client.chat.completions.create() calls are now traced
response = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Hello"}],
)
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `client` | OpenAI client | The client instance to wrap (mutated in place) |
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `trace_id` | str or None | Existing trace to add spans to |
| `agent_name` | str or None | Agent name for auto-created traces (default `"openai-agent"`) |

**What it captures:**

- Input messages
- First choice text content
- Tool calls (as child `tool_call` spans)
- Finish reason
- Token usage (`prompt_tokens`, `completion_tokens`)
- Errors

Returns the same client instance.

---

### create_lantern_crewai_handler(tracer, *, agent_name=None)

Creates a lifecycle handler for CrewAI crews. Install: `pip install lantern-ai[crewai]`.

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.crewai import create_lantern_crewai_handler

tracer = LanternTracer(...)
handler = create_lantern_crewai_handler(tracer, agent_name="my-crew")

# Pass as step_callback to your Crew
crew = Crew(agents=[...], tasks=[...], step_callback=handler)
crew.kickoff()
handler.finish()
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `agent_name` | str or None | Agent name for traces (default `"crewai-agent"`) |

**Returns:** `LanternCrewAIHandler` with methods `on_task_start/end`, `on_llm_start/end`, `on_tool_start/end`, and `finish()`.

---

### create_lantern_pydantic_handler(tracer, *, agent_name=None)

Creates a lifecycle handler for Pydantic AI agents. Install: `pip install lantern-ai[pydantic-ai]`.

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.pydantic_ai import create_lantern_pydantic_handler

tracer = LanternTracer(...)
handler = create_lantern_pydantic_handler(tracer)

# Register with your Pydantic AI agent
agent = Agent(model="openai:gpt-4o", instrument=handler)
result = await agent.run("Hello")
handler.finish()
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `agent_name` | str or None | Agent name for traces (default `"pydantic-ai-agent"`) |

**Returns:** `LanternPydanticHandler` with methods `on_llm_start/end`, `on_tool_start/end`, `on_step()`, and `finish()`.

---

### create_lantern_autogen_handler(tracer, *, agent_name=None)

Creates a message hook handler for AutoGen/AG2 conversations. Install: `pip install lantern-ai[autogen]`.

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.autogen import create_lantern_autogen_handler

tracer = LanternTracer(...)
handler = create_lantern_autogen_handler(tracer)

# Register with AutoGen
groupchat = autogen.GroupChat(agents=[...], messages=[])
manager = autogen.GroupChatManager(groupchat=groupchat, llm_config=llm_config)
manager.register_hook("on_message", handler.on_message)
manager.initiate_chat(user_proxy, message="Hello")
handler.finish()
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `agent_name` | str or None | Agent name for traces (default `"autogen-agent"`) |

**Returns:** `LanternAutoGenHandler` with methods `on_message()`, `on_llm_start/end`, `on_tool_start/end`, and `finish()`.

---

### create_lantern_haystack_handler(tracer, *, agent_name=None)

Creates a pipeline callback handler for Haystack pipelines. Install: `pip install lantern-ai[haystack]`.

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.haystack import create_lantern_haystack_handler

tracer = LanternTracer(...)
handler = create_lantern_haystack_handler(tracer)

# Register with your Haystack pipeline
pipeline = Pipeline()
pipeline.add_component("llm", OpenAIGenerator())
pipeline.add_listener(handler)
result = pipeline.run({"llm": {"prompt": "Hello"}})
handler.finish()
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `agent_name` | str or None | Agent name for traces (default `"haystack-agent"`) |

**Returns:** `LanternHaystackHandler` with methods `on_pipeline_start/end`, `on_component_start/end`, and `finish()`.

---

### create_lantern_dspy_handler(tracer, *, agent_name=None)

Creates a module tracing handler for DSPy programs. Install: `pip install lantern-ai[dspy]`.

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.dspy import create_lantern_dspy_handler

tracer = LanternTracer(...)
handler = create_lantern_dspy_handler(tracer)

# Register with DSPy
import dspy
dspy.configure(lm=dspy.LM("openai/gpt-4o"), trace=[handler])
program = dspy.ChainOfThought("question -> answer")
result = program(question="What is 2+2?")
handler.finish()
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `agent_name` | str or None | Agent name for traces (default `"dspy-agent"`) |

**Returns:** `LanternDSPyHandler` with methods `on_predict_start/end`, `on_lm_start/end`, and `finish()`.

---

### create_lantern_smolagents_handler(tracer, *, agent_name=None)

Creates a step callback handler for Smolagents. Install: `pip install lantern-ai[smolagents]`.

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.smolagents import create_lantern_smolagents_handler

tracer = LanternTracer(...)
handler = create_lantern_smolagents_handler(tracer)

# Register with your Smolagents agent
from smolagents import CodeAgent, HfApiModel
agent = CodeAgent(tools=[], model=HfApiModel(), step_callbacks=[handler])
result = agent.run("What is 2+2?")
handler.finish()
```

**Parameters:**

| Parameter | Type | Description |
|---|---|---|
| `tracer` | `LanternTracer` | Tracer to record spans on |
| `agent_name` | str or None | Agent name for traces (default `"smolagents-agent"`) |

**Returns:** `LanternSmolagentsHandler` with methods `on_step_start/end`, `on_llm_call/end`, `on_tool_start/end`, and `finish()`.

---

## Data Types

All types use snake_case fields internally and serialise to camelCase via
`to_dict()` to match the Lantern ingest API.

### Trace

```python
@dataclass
class Trace:
    id: str                                      # UUID
    session_id: str                              # UUID
    agent_name: str
    agent_version: Optional[str] = None
    environment: str = "production"
    start_time: float                            # Unix timestamp in milliseconds
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    status: TraceStatus = "running"              # "running" | "success" | "error"
    spans: List[Span] = []
    metadata: Dict[str, Any] = {}
    source: Optional[TraceSource] = None
    scores: Optional[List[EvalScore]] = None
    total_input_tokens: int = 0
    total_output_tokens: int = 0
    estimated_cost_usd: float = 0.0
```

### Span

```python
@dataclass
class Span:
    id: str                                      # UUID
    trace_id: str                                # UUID
    parent_span_id: Optional[str] = None
    type: SpanType = "custom"                    # "llm_call" | "tool_call" | "reasoning_step" | "retrieval" | "custom"
    start_time: float                            # Unix timestamp in milliseconds
    end_time: Optional[float] = None
    duration_ms: Optional[float] = None
    input: SpanInput = SpanInput()
    output: Optional[SpanOutput] = None
    model: Optional[str] = None
    input_tokens: Optional[int] = None
    output_tokens: Optional[int] = None
    estimated_cost_usd: Optional[float] = None
    tool_name: Optional[str] = None
    tool_result: Optional[Any] = None
    error: Optional[str] = None
```

### SpanInput

```python
@dataclass
class SpanInput:
    messages: Optional[List[Dict[str, str]]] = None
    prompt: Optional[str] = None
    args: Optional[Any] = None
```

### SpanOutput

```python
@dataclass
class SpanOutput:
    content: Optional[str] = None
    tool_calls: Optional[List[Any]] = None
    stop_reason: Optional[str] = None
```

### TraceSource

```python
@dataclass
class TraceSource:
    service_name: str
    sdk_version: Optional[str] = None
    exporter_type: Optional[str] = None
```

### EvalScore

```python
@dataclass
class EvalScore:
    scorer: str
    score: float
    label: Optional[str] = None
    reasoning: Optional[str] = None
```

---

## Cost Estimation

The Python SDK estimates costs using the same model pricing as the TypeScript
SDK. Prices are in USD per 1,000 tokens:

| Model | Input | Output |
|---|---|---|
| `claude-sonnet-4-5-20251001` | $0.003 | $0.015 |
| `claude-haiku-4-5-20251001` | $0.0008 | $0.004 |
| `claude-opus-4-5-20251001` | $0.015 | $0.075 |
| `gpt-4o` | $0.005 | $0.015 |
| `gpt-4o-mini` | $0.00015 | $0.0006 |
| Unknown model (default) | $0.001 | $0.002 |

Cost is computed automatically when `set_tokens()` or `end()` is called with
token counts on a span that has a model set.
