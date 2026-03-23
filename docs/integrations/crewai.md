# CrewAI

Trace CrewAI task executions, LLM calls, and tool invocations with a callback handler that captures the full crew lifecycle.

## Installation

```bash
pip install lantern-ai[crewai]
```

This installs `lantern-ai` along with `crewai>=0.80.0` as a dependency.

## Setup

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.crewai import create_lantern_crewai_handler

tracer = LanternTracer(
    api_key="your-lantern-api-key",
    base_url="https://your-lantern-instance.com",
)

handler = create_lantern_crewai_handler(tracer, agent_name="my-crew")
# agent_name is optional, defaults to "crewai-agent"
```

## Usage

### Trace task lifecycle

```python
from crewai import Agent, Task, Crew

researcher = Agent(
    role="Researcher",
    goal="Find information about AI trends",
    backstory="You are an expert researcher.",
)

task = Task(
    description="Research the latest AI safety developments",
    agent=researcher,
)

crew = Crew(agents=[researcher], tasks=[task])

# Hook into task lifecycle
handler.on_task_start(task_name="research_ai_safety", agent_name="Researcher")
result = crew.kickoff()
handler.on_task_end(task_name="research_ai_safety", output=str(result))

handler.finish()  # End the trace
```

### Trace LLM calls within a crew

```python
# LLM call tracking returns a span_id for pairing start/end
span_id = handler.on_llm_start(
    model="gpt-4",
    messages=[{"role": "user", "content": "Summarize AI safety research"}],
)

# After the LLM responds:
handler.on_llm_end(
    span_id=span_id,
    output="AI safety research focuses on alignment, interpretability...",
    input_tokens=42,
    output_tokens=128,
)
```

### Trace tool invocations

```python
span_id = handler.on_tool_start(tool_name="web_search", args={"query": "AI safety 2025"})
# After the tool returns:
handler.on_tool_end(span_id=span_id, output="Found 10 relevant articles...")
```

## What Gets Traced

| CrewAI Event | Lantern Span Type | Captured Data |
|-------------|-------------------|---------------|
| `on_task_start` / `on_task_end` | `custom` | Task name, agent name, task output |
| `on_llm_start` / `on_llm_end` | `llm_call` | Model name, messages, response, token counts |
| `on_tool_start` / `on_tool_end` | `tool_call` | Tool name, arguments, output |

### Trace lifecycle

The handler lazily creates a trace on the first event. All subsequent events attach to that trace. Call `handler.finish()` when the crew run is complete to close the trace with `"success"` status.

## Troubleshooting

**Spans not appearing**
- Verify that `finish()` is called after the crew run completes. Without it, the trace may not be flushed.
- Check that `api_key` and `base_url` are correct.

**Token counts always zero**
- Token counts must be passed explicitly to `on_llm_end()`. CrewAI does not always surface token usage from the underlying provider — you may need to extract it from the LLM response.

**Task spans overlap**
- Tasks are tracked by name. If two tasks share the same `task_name`, `on_task_end` will close whichever was most recently opened with that name.

## API Reference

```python
def create_lantern_crewai_handler(
    tracer: LanternTracer,
    *,
    agent_name: str | None = None,
) -> LanternCrewAIHandler
```

### LanternCrewAIHandler methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `on_task_start` | `task_name: str`, `agent_name: str = ""` | `None` | Start a task span |
| `on_task_end` | `task_name: str`, `output: str = ""` | `None` | End a task span |
| `on_llm_start` | `model: str = ""`, `messages: list = None` | `str` (span_id) | Start an LLM call span |
| `on_llm_end` | `span_id: str`, `output: str = ""`, `input_tokens: int = 0`, `output_tokens: int = 0` | `None` | End an LLM call span |
| `on_tool_start` | `tool_name: str`, `args: Any = None` | `str` (span_id) | Start a tool call span |
| `on_tool_end` | `span_id: str`, `output: str = ""` | `None` | End a tool call span |
| `finish` | — | `None` | End the trace |
