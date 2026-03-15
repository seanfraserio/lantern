# Tutorial: Instrument a Python Agent

In this tutorial you will build a 3-step support-ticket agent in Python, instrument it with the Lantern SDK, and see the full reasoning chain in the dashboard. You will also add custom spans and metadata.

**Time:** ~15 minutes

---

## What you will build

A support-ticket agent that:

1. **Classifies** the ticket (billing, technical, or general)
2. **Looks up** relevant context based on the category
3. **Writes** a customer-facing response

Each step becomes a span in Lantern, giving you full visibility into the reasoning chain, token usage, and cost.

---

## Prerequisites

- Python 3.10+
- An Anthropic API key
- A Lantern API key (sign up at [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev))

---

## 1. Set up the project

```bash
mkdir lantern-py-tutorial && cd lantern-py-tutorial
python -m venv .venv
source .venv/bin/activate
pip install lantern-ai anthropic
```

Set your environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LANTERN_API_KEY="ltn_..."
```

---

## 2. Create the tracer

Create a file called `agent.py`. Start by setting up the tracer and wrapping the Anthropic client:

```python
import os
from anthropic import Anthropic
from lantern_ai import LanternTracer, wrap_anthropic_client

tracer = LanternTracer(
    service_name="support-agent",
    environment="development",
    api_key=os.environ["LANTERN_API_KEY"],
    endpoint="https://ingest.openlanternai.com",
)

client = Anthropic()
wrap_anthropic_client(client, tracer)
```

`wrap_anthropic_client()` monkey-patches `client.messages.create()` so every LLM call automatically produces a span with input messages, output content, token counts, and estimated cost.

> **Note:** The Python SDK also supports `AsyncAnthropic`. Pass an async client and the wrapper handles it automatically.

---

## 3. Build step 1 — classify the ticket

```python
def classify_ticket(trace_id: str, ticket: str) -> str:
    response = client.messages.create(
        model="claude-sonnet-4-5-20251001",
        max_tokens=16,
        messages=[
            {
                "role": "user",
                "content": (
                    "Classify this support ticket into exactly one category: "
                    "billing, technical, or general.\n\n"
                    f'Ticket: "{ticket}"\n\n'
                    "Reply with the category name only."
                ),
            }
        ],
    )
    return response.content[0].text.strip().lower()
```

The SDK automatically creates an `llm_call` span for this `messages.create()` call.

---

## 4. Build step 2 — look up context

This step is not an LLM call, so we will create a **custom span** manually:

```python
from lantern_ai import SpanInput, SpanOutput

def lookup_context(trace_id: str, category: str) -> str:
    # Start a custom span for the lookup step
    span = tracer.start_span(
        trace_id,
        type="retrieval",
        input=SpanInput(prompt=f"Looking up knowledge base for category: {category}"),
    )

    # Simulate a database or knowledge-base lookup
    knowledge_base = {
        "billing": (
            "Refund policy: full refund within 30 days. "
            "Invoices regenerated on request. "
            "Contact billing@example.com for disputes."
        ),
        "technical": (
            "Check status page at status.example.com. "
            "Known issue: API latency on us-east-1. "
            "Workaround: retry with exponential backoff."
        ),
        "general": (
            "Business hours: Mon-Fri 9am-6pm GMT. "
            "SLA response time: 4 hours for Team plan, 1 hour for Enterprise."
        ),
    }

    context = knowledge_base.get(category, knowledge_base["general"])

    # End the span with the result
    tracer.end_span(span.id, SpanOutput(content=context))

    return context
```

This `retrieval` span appears as a child in the trace timeline, showing exactly how long the lookup took.

---

## 5. Build step 3 — write the response

```python
def write_response(trace_id: str, ticket: str, category: str, context: str) -> str:
    response = client.messages.create(
        model="claude-sonnet-4-5-20251001",
        max_tokens=512,
        messages=[
            {
                "role": "user",
                "content": (
                    "You are a helpful support agent. "
                    "Write a friendly response to the customer's ticket.\n\n"
                    f"Category: {category}\n"
                    f"Relevant policy: {context}\n\n"
                    f'Customer ticket: "{ticket}"\n\n'
                    "Respond directly to the customer."
                ),
            }
        ],
    )
    return response.content[0].text
```

---

## 6. Wire it all together

```python
def handle_ticket(ticket: str) -> None:
    # Start a trace for this agent execution
    trace = tracer.start_trace(
        agent_name="support-agent",
        agent_version="1.0.0",
        metadata={
            "ticket_text": ticket,
            "source": "tutorial",
        },
    )

    try:
        print("Classifying ticket...")
        category = classify_ticket(trace.id, ticket)
        print(f"Category: {category}")

        print("Looking up context...")
        context = lookup_context(trace.id, category)
        print(f"Context: {context[:60]}...")

        print("Writing response...")
        reply = write_response(trace.id, ticket, category, context)
        print(f"\nAgent response:\n{reply}")

        # Mark the trace as successful
        tracer.end_trace(trace.id, "success")
    except Exception:
        # Mark the trace as failed
        tracer.end_trace(trace.id, "error")
        raise


handle_ticket("I was charged twice for my subscription last month. Please help!")
tracer.shutdown()
print("\nTrace sent to Lantern.")
```

---

## 7. Run the agent

```bash
python agent.py
```

Expected output:

```
Classifying ticket...
Category: billing
Looking up context...
Context: Refund policy: full refund within 30 days. Invoices rege...
Writing response...

Agent response:
I'm sorry to hear about the double charge on your subscription...

Trace sent to Lantern.
```

---

## 8. View the trace in the dashboard

Open [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev) and navigate to **Traces**. You will see a trace for `support-agent` with three spans:

| Span | Type | Details |
|------|------|---------|
| Classify ticket | `llm_call` | Model, tokens, cost, input/output |
| Knowledge base lookup | `retrieval` | Duration, retrieved content |
| Write response | `llm_call` | Model, tokens, cost, input/output |

Click any span to inspect the full input messages, output content, and token breakdown.

---

## 9. Use the context-manager API for spans

The Python SDK supports a context-manager pattern for spans, which automatically handles errors and timing:

```python
from lantern_ai import AgentSpan, SpanInput

with AgentSpan(trace_id=trace.id, type="custom", model=None) as span:
    span.set_input(prompt="Running a custom processing step")
    result = some_processing_function()
    span.set_output(content=str(result))
```

If an exception occurs inside the `with` block, the span automatically records the error and closes itself.

---

## 10. Add metadata and evaluation scores

Metadata is set in `start_trace()`:

```python
trace = tracer.start_trace(
    agent_name="support-agent",
    metadata={
        "ticket_id": "TKT-12345",
        "customer_id": "cust_abc",
        "priority": "high",
        "channel": "email",
    },
)
```

Evaluation scores can be attached by posting to the API:

```bash
curl -X POST https://api.openlanternai.com/v1/traces/<trace-id>/scores \
  -H "Authorization: Bearer $LANTERN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "scores": [
      {"scorer": "tone", "score": 0.92, "label": "pass"},
      {"scorer": "accuracy", "score": 0.85, "label": "pass"}
    ]
  }'
```

These scores appear on the trace detail page and feed into Lantern's regression detection.

---

## 11. Use with OpenAI instead

The SDK also supports OpenAI. Swap the client wrapper:

```python
from openai import OpenAI
from lantern_ai import LanternTracer, wrap_openai_client

tracer = LanternTracer(
    service_name="support-agent",
    api_key=os.environ["LANTERN_API_KEY"],
    endpoint="https://ingest.openlanternai.com",
)

openai_client = OpenAI()
wrap_openai_client(openai_client, tracer)

# All client.chat.completions.create() calls are now traced
response = openai_client.chat.completions.create(
    model="gpt-4o",
    max_tokens=256,
    messages=[{"role": "user", "content": "Hello!"}],
)
```

---

## Summary

You built a 3-step agent, instrumented it with the Lantern Python SDK, and viewed the full reasoning chain in the dashboard. You learned how to:

- Create a tracer with `LanternExporter` (via `api_key` and `endpoint`)
- Auto-instrument Anthropic calls with `wrap_anthropic_client()`
- Create custom spans for non-LLM steps
- Use the context-manager API for spans
- Attach metadata to traces
- Add evaluation scores via the API

Next: [Set up alerts](../how-to/set-up-alerts.md) | [Monitor costs](../how-to/monitor-costs.md) | [Detect PII](../how-to/detect-pii.md)
