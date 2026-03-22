# Smolagents

Trace HuggingFace Smolagents step-by-step reasoning, LLM calls, and tool invocations with a callback handler designed for step-based agent execution.

## Installation

```bash
pip install lantern-ai[smolagents]
```

This installs `lantern-ai` along with `smolagents>=1.0.0` as a dependency.

## Setup

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.smolagents import create_lantern_smolagents_handler

tracer = LanternTracer(
    api_key="your-lantern-api-key",
    base_url="https://your-lantern-instance.com",
)

handler = create_lantern_smolagents_handler(tracer, agent_name="my-smolagent")
# agent_name is optional, defaults to "smolagents-agent"
```

## Usage

### Trace agent steps

Smolagents uses a step-based execution model where the agent reasons through a task in numbered steps:

```python
from smolagents import CodeAgent, HfApiModel

model = HfApiModel()
agent = CodeAgent(tools=[], model=model)

# Trace each reasoning step
handler.on_step_start(step_name="analyze_task", step_number=1)
# ... agent processes step 1 ...
handler.on_step_end(step_number=1, output="Identified that I need to search for information")

handler.on_step_start(step_name="execute_search", step_number=2)
# ... agent processes step 2 ...
handler.on_step_end(step_number=2, output="Found relevant results")
```

### Trace LLM calls

```python
span_id = handler.on_llm_call(
    model="meta-llama/Llama-3-70B-Instruct",
    messages=[{"role": "user", "content": "Search for AI news"}],
)

handler.on_llm_end(
    span_id=span_id,
    output="I'll search for the latest AI news...",
    input_tokens=25,
    output_tokens=60,
)
```

### Trace tool calls

```python
span_id = handler.on_tool_start(tool_name="web_search", args={"query": "latest AI news 2025"})
handler.on_tool_end(span_id=span_id, output="Top 5 AI news articles...")
```

### Complete agent run example

```python
# Step 1: Planning
handler.on_step_start(step_name="plan", step_number=1)
llm_span = handler.on_llm_call(model="Llama-3-70B", messages=[...])
handler.on_llm_end(span_id=llm_span, output="Plan: search then summarize")
handler.on_step_end(step_number=1, output="Plan created")

# Step 2: Tool use
handler.on_step_start(step_name="search", step_number=2)
tool_span = handler.on_tool_start(tool_name="web_search", args={"query": "AI trends"})
handler.on_tool_end(span_id=tool_span, output="Found 10 articles")
handler.on_step_end(step_number=2, output="Search complete")

# Step 3: Synthesis
handler.on_step_start(step_name="synthesize", step_number=3)
llm_span = handler.on_llm_call(model="Llama-3-70B", messages=[...])
handler.on_llm_end(span_id=llm_span, output="Summary of AI trends...", input_tokens=500, output_tokens=200)
handler.on_step_end(step_number=3, output="Final answer generated")

handler.finish()
```

## What Gets Traced

| Smolagents Event | Lantern Span Type | Captured Data |
|------------------|-------------------|---------------|
| `on_step_start` / `on_step_end` | `reasoning_step` | Step number, step name, output |
| `on_llm_call` / `on_llm_end` | `llm_call` | Model name, messages, response, token counts |
| `on_tool_start` / `on_tool_end` | `tool_call` | Tool name, arguments, output |

### Step tracking

Steps are tracked by `step_number`. Each step becomes a `reasoning_step` span that captures the agent's iterative reasoning process. This maps naturally to how Smolagents executes — the dashboard shows the step-by-step progression.

## Troubleshooting

**Steps not appearing in order**
- Steps are tracked by `step_number`. Make sure `on_step_end` uses the same `step_number` as the corresponding `on_step_start`.

**LLM method is `on_llm_call`, not `on_llm_start`**
- The Smolagents handler uses `on_llm_call` (not `on_llm_start`) to match Smolagents' naming convention. The end method is still `on_llm_end`.

**Step spans remaining open**
- Call `on_step_end` for every `on_step_start`, then call `finish()` when the agent run completes.

## API Reference

```python
def create_lantern_smolagents_handler(
    tracer: LanternTracer,
    *,
    agent_name: str | None = None,
) -> LanternSmolagentsHandler
```

### LanternSmolagentsHandler methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `on_step_start` | `step_name: str = ""`, `step_number: int = 0` | `str` (span_id) | Start a reasoning step span |
| `on_step_end` | `step_number: int = 0`, `output: str = ""` | `None` | End a reasoning step span |
| `on_llm_call` | `model: str = ""`, `messages: list = None` | `str` (span_id) | Start an LLM call span |
| `on_llm_end` | `span_id: str`, `output: str = ""`, `input_tokens: int = 0`, `output_tokens: int = 0` | `None` | End an LLM call span |
| `on_tool_start` | `tool_name: str`, `args: Any = None` | `str` (span_id) | Start a tool call span |
| `on_tool_end` | `span_id: str`, `output: str = ""` | `None` | End a tool call span |
| `finish` | — | `None` | End the trace |
