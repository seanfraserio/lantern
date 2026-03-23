# AutoGen / AG2

Trace AutoGen multi-agent message passing, LLM calls, and tool invocations with a callback handler that captures agent-to-agent communication.

## Installation

```bash
pip install lantern-ai[autogen]
```

This installs `lantern-ai` along with `autogen-agentchat>=0.4.0` as a dependency.

## Setup

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.autogen import create_lantern_autogen_handler

tracer = LanternTracer(
    api_key="your-lantern-api-key",
    base_url="https://your-lantern-instance.com",
)

handler = create_lantern_autogen_handler(tracer, agent_name="my-autogen-team")
# agent_name is optional, defaults to "autogen-agent"
```

## Usage

### Trace agent-to-agent messages

AutoGen's multi-agent conversations involve agents sending messages to each other. Track each message exchange:

```python
from autogen import AssistantAgent, UserProxyAgent

assistant = AssistantAgent("assistant", llm_config={"model": "gpt-4"})
user_proxy = UserProxyAgent("user_proxy", code_execution_config=False)

# Track a message from user_proxy to assistant
span_id = handler.on_message(
    sender="user_proxy",
    recipient="assistant",
    content="Write a Python function to calculate fibonacci numbers",
)

# After the message is processed:
handler.on_message_end(span_id=span_id, output="Here's the fibonacci function...")
```

### Trace LLM calls

```python
span_id = handler.on_llm_start(
    model="gpt-4",
    messages=[{"role": "user", "content": "Write fibonacci in Python"}],
)

handler.on_llm_end(
    span_id=span_id,
    output="def fibonacci(n): ...",
    input_tokens=15,
    output_tokens=89,
)
```

### Trace tool calls

```python
span_id = handler.on_tool_start(tool_name="execute_code", args={"code": "print(fibonacci(10))"})
handler.on_tool_end(span_id=span_id, output="55")
```

### Full conversation example

```python
# Start tracking
handler.on_message(sender="user_proxy", recipient="assistant", content="Solve this math problem: 2+2")
span_id = handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "2+2"}])
handler.on_llm_end(span_id=span_id, output="4", input_tokens=5, output_tokens=1)
handler.on_message_end(span_id=msg_span_id, output="The answer is 4")

handler.finish()
```

## What Gets Traced

| AutoGen Event | Lantern Span Type | Captured Data |
|---------------|-------------------|---------------|
| `on_message` / `on_message_end` | `custom` | Sender, recipient, message content, response |
| `on_llm_start` / `on_llm_end` | `llm_call` | Model name, messages, response, token counts |
| `on_tool_start` / `on_tool_end` | `tool_call` | Tool name, arguments, output |

### Message tracking

Agent-to-agent messages are tracked with a composite key (`msg_{sender}_{recipient}`). Each message exchange becomes a `custom` span showing the communication flow between agents.

## Troubleshooting

**Spans not appearing**
- Make sure `finish()` is called when the conversation ends.
- Verify `api_key` and `base_url` are correct.

**Message spans overlapping**
- Messages between the same sender-recipient pair overwrite each other in the active spans map. If agent A sends two messages to agent B without the first one ending, the second will replace the first.

**Token counts always zero**
- Token counts must be passed explicitly to `on_llm_end()`. AutoGen doesn't always expose token usage from the underlying LLM.

## API Reference

```python
def create_lantern_autogen_handler(
    tracer: LanternTracer,
    *,
    agent_name: str | None = None,
) -> LanternAutoGenHandler
```

### LanternAutoGenHandler methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `on_message` | `sender: str = ""`, `recipient: str = ""`, `content: str = ""` | `str` (span_id) | Start a message exchange span |
| `on_message_end` | `span_id: str`, `output: str = ""` | `None` | End a message exchange span |
| `on_llm_start` | `model: str = ""`, `messages: list = None` | `str` (span_id) | Start an LLM call span |
| `on_llm_end` | `span_id: str`, `output: str = ""`, `input_tokens: int = 0`, `output_tokens: int = 0` | `None` | End an LLM call span |
| `on_tool_start` | `tool_name: str`, `args: Any = None` | `str` (span_id) | Start a tool call span |
| `on_tool_end` | `span_id: str`, `output: str = ""` | `None` | End a tool call span |
| `finish` | — | `None` | End the trace |
