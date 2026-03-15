# lantern-ai

Python SDK for [Lantern](https://openlanternai.com) -- agent observability for the enterprise.

## Quick Start

```bash
pip install lantern-ai
```

```python
from lantern_ai import LanternTracer, LanternExporter

tracer = LanternTracer(
    service_name="my-agent",
    agent_name="support-triage",
    environment="production",
    exporter=LanternExporter(
        endpoint="https://ingest.openlanternai.com",
        api_key="lnt_your_api_key",
    ),
)
```

## Auto-Instrumentation

```python
from anthropic import Anthropic
from lantern_ai import wrap_anthropic_client

client = Anthropic()
wrap_anthropic_client(client, tracer)

# All messages.create() calls are now traced automatically
```

## Manual Tracing

```python
trace = tracer.start_trace(agent_name="my-agent")

with tracer.start_span(trace.id, type="llm_call", model="claude-sonnet-4-5-20251001") as span:
    span.set_input(messages=[{"role": "user", "content": "Hello"}])
    # ... do work ...
    span.set_output(content="Hi there!")
    span.set_tokens(input_tokens=10, output_tokens=5)

tracer.end_trace(trace.id)
```

## Console Exporter (Development)

```python
from lantern_ai import LanternTracer, ConsoleExporter

tracer = LanternTracer(
    service_name="my-agent",
    agent_name="support-triage",
    exporter=ConsoleExporter(verbose=True),
)
```

## OpenAI Auto-Instrumentation

```python
from openai import OpenAI
from lantern_ai import wrap_openai_client

client = OpenAI()
wrap_openai_client(client, tracer)

# All chat.completions.create() calls are now traced automatically
```
