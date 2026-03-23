# Pydantic AI

Trace Pydantic AI agent LLM calls, tool invocations, and reasoning steps with a callback handler.

## Installation

```bash
pip install lantern-ai[pydantic-ai]
```

This installs `lantern-ai` along with `pydantic-ai>=0.1.0` as a dependency.

## Setup

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.pydantic_ai import create_lantern_pydantic_handler

tracer = LanternTracer(
    api_key="your-lantern-api-key",
    base_url="https://your-lantern-instance.com",
)

handler = create_lantern_pydantic_handler(tracer, agent_name="my-pydantic-agent")
# agent_name is optional, defaults to "pydantic-ai-agent"
```

## Usage

### Trace LLM calls

```python
span_id = handler.on_llm_start(
    model="gpt-4",
    messages=[
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "What is Pydantic AI?"},
    ],
)

handler.on_llm_end(
    span_id=span_id,
    output="Pydantic AI is a framework for building type-safe AI agents...",
    input_tokens=35,
    output_tokens=72,
)
```

### Trace tool calls

```python
span_id = handler.on_tool_start(tool_name="search_docs", args={"query": "pydantic models"})
handler.on_tool_end(span_id=span_id, output="Found 5 relevant documents")
```

### Trace reasoning steps

Pydantic AI agents can expose intermediate reasoning steps. Track them with `on_step`:

```python
span_id = handler.on_step(step_name="validate_output_schema")
# ... step completes ...
# End via tracer.end_span() if needed
```

### Complete agent run example

```python
from pydantic_ai import Agent

agent = Agent("openai:gpt-4", system_prompt="You are a data analyst.")

# Hook into the agent's lifecycle
handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "Analyze sales data"}])
result = agent.run_sync("Analyze the Q4 sales data")
handler.on_llm_end(span_id=span_id, output=result.data)

handler.finish()
```

## What Gets Traced

| Pydantic AI Event | Lantern Span Type | Captured Data |
|-------------------|-------------------|---------------|
| `on_llm_start` / `on_llm_end` | `llm_call` | Model name, messages, response, token counts |
| `on_tool_start` / `on_tool_end` | `tool_call` | Tool name, arguments, output |
| `on_step` | `reasoning_step` | Step name |

### Trace lifecycle

The handler lazily creates a trace on the first event. Call `handler.finish()` when the agent run is complete to close the trace.

## Troubleshooting

**Spans not appearing**
- Make sure `finish()` is called after the agent run completes.
- Verify `api_key` and `base_url` are correct.

**Reasoning steps not showing**
- `on_step()` creates a `reasoning_step` span but does not auto-close it. You need to end it explicitly via `tracer.end_span()` or it will remain open.

**Token counts always zero**
- Token counts must be passed explicitly to `on_llm_end()`. Extract them from the underlying LLM response.

## API Reference

```python
def create_lantern_pydantic_handler(
    tracer: LanternTracer,
    *,
    agent_name: str | None = None,
) -> LanternPydanticAIHandler
```

### LanternPydanticAIHandler methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `on_llm_start` | `model: str = ""`, `messages: list = None` | `str` (span_id) | Start an LLM call span |
| `on_llm_end` | `span_id: str`, `output: str = ""`, `input_tokens: int = 0`, `output_tokens: int = 0` | `None` | End an LLM call span |
| `on_tool_start` | `tool_name: str`, `args: Any = None` | `str` (span_id) | Start a tool call span |
| `on_tool_end` | `span_id: str`, `output: str = ""` | `None` | End a tool call span |
| `on_step` | `step_name: str = ""` | `str` (span_id) | Start a reasoning step span |
| `finish` | — | `None` | End the trace |
