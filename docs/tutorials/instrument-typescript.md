# Tutorial: Instrument a TypeScript Agent

In this tutorial you will build a 3-step support-ticket agent in TypeScript, instrument it with the Lantern SDK, and see the full reasoning chain in the dashboard. You will also add custom spans and metadata.

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

- Node.js 20+
- An Anthropic API key
- A Lantern API key (sign up at [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev))

---

## 1. Set up the project

```bash
mkdir lantern-ts-tutorial && cd lantern-ts-tutorial
npm init -y
npm install @openlantern-ai/sdk @anthropic-ai/sdk
```

Set your environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LANTERN_API_KEY="ltn_..."
```

---

## 2. Create the tracer

Create a file called `agent.ts`. Start by setting up the tracer and wrapping the Anthropic client:

```typescript
import Anthropic from "@anthropic-ai/sdk";
import {
  LanternTracer,
  LanternExporter,
  wrapAnthropicClient,
} from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "support-agent",
  environment: "development",
  exporter: new LanternExporter({
    endpoint: "https://ingest.openlanternai.com",
    apiKey: process.env.LANTERN_API_KEY,
  }),
});

const anthropic = wrapAnthropicClient(new Anthropic(), tracer);
```

`wrapAnthropicClient()` monkey-patches `client.messages.create()` so every LLM call automatically produces a span with input messages, output content, token counts, and estimated cost.

---

## 3. Build step 1 — classify the ticket

```typescript
async function classifyTicket(traceId: string, ticket: string): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20251001",
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: `Classify this support ticket into exactly one category: billing, technical, or general.\n\nTicket: "${ticket}"\n\nReply with the category name only.`,
      },
    ],
  });

  const category = response.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim()
    .toLowerCase();

  return category;
}
```

The SDK automatically creates an `llm_call` span for this `messages.create()` call.

---

## 4. Build step 2 — look up context

This step is not an LLM call, so we will create a **custom span** manually:

```typescript
async function lookupContext(traceId: string, category: string): Promise<string> {
  // Start a custom span for the lookup step
  const span = tracer.startSpan(traceId, {
    type: "retrieval",
    input: { prompt: `Looking up knowledge base for category: ${category}` },
  });

  // Simulate a database or knowledge-base lookup
  const knowledgeBase: Record<string, string> = {
    billing: "Refund policy: full refund within 30 days. Invoices regenerated on request. Contact billing@example.com for disputes.",
    technical: "Check status page at status.example.com. Known issue: API latency on us-east-1. Workaround: retry with exponential backoff.",
    general: "Business hours: Mon-Fri 9am-6pm GMT. SLA response time: 4 hours for Team plan, 1 hour for Enterprise.",
  };

  const context = knowledgeBase[category] ?? knowledgeBase["general"];

  // End the span with the result
  tracer.endSpan(span.id, { content: context });

  return context;
}
```

This `retrieval` span appears as a child in the trace timeline, showing exactly how long the lookup took.

---

## 5. Build step 3 — write the response

```typescript
async function writeResponse(
  traceId: string,
  ticket: string,
  category: string,
  context: string,
): Promise<string> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20251001",
    max_tokens: 512,
    messages: [
      {
        role: "user",
        content: `You are a helpful support agent. Write a friendly response to the customer's ticket.\n\nCategory: ${category}\nRelevant policy: ${context}\n\nCustomer ticket: "${ticket}"\n\nRespond directly to the customer.`,
      },
    ],
  });

  return response.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("");
}
```

---

## 6. Wire it all together

```typescript
async function handleTicket(ticket: string): Promise<void> {
  // Start a trace for this agent execution
  const trace = tracer.startTrace({
    agentName: "support-agent",
    agentVersion: "1.0.0",
    metadata: {
      ticketText: ticket,
      source: "tutorial",
    },
  });

  try {
    console.log("Classifying ticket...");
    const category = await classifyTicket(trace.id, ticket);
    console.log(`Category: ${category}`);

    console.log("Looking up context...");
    const context = await lookupContext(trace.id, category);
    console.log(`Context: ${context.slice(0, 60)}...`);

    console.log("Writing response...");
    const reply = await writeResponse(trace.id, ticket, category, context);
    console.log(`\nAgent response:\n${reply}`);

    // Mark the trace as successful
    tracer.endTrace(trace.id, "success");
  } catch (error) {
    // Mark the trace as failed
    tracer.endTrace(trace.id, "error");
    throw error;
  }
}

// Run the agent
await handleTicket("I was charged twice for my subscription last month. Please help!");
await tracer.shutdown();
console.log("\nTrace sent to Lantern.");
```

---

## 7. Run the agent

```bash
npx tsx agent.ts
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

## 9. Add metadata and evaluation scores

You can attach arbitrary metadata when starting a trace, and add evaluation scores via the API after the trace is exported.

Metadata is set in `startTrace()`:

```typescript
const trace = tracer.startTrace({
  agentName: "support-agent",
  metadata: {
    ticketId: "TKT-12345",
    customerId: "cust_abc",
    priority: "high",
    channel: "email",
  },
});
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

## 10. Use with OpenAI instead

The SDK also supports OpenAI. Swap the client wrapper:

```typescript
import OpenAI from "openai";
import { LanternTracer, LanternExporter, wrapOpenAIClient } from "@openlantern-ai/sdk";

const tracer = new LanternTracer({
  serviceName: "support-agent",
  exporter: new LanternExporter({
    endpoint: "https://ingest.openlanternai.com",
    apiKey: process.env.LANTERN_API_KEY,
  }),
});

const openai = wrapOpenAIClient(new OpenAI(), tracer);

// All client.chat.completions.create() calls are now traced
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  max_tokens: 256,
  messages: [{ role: "user", content: "Hello!" }],
});
```

---

## Summary

You built a 3-step agent, instrumented it with the Lantern TypeScript SDK, and viewed the full reasoning chain in the dashboard. You learned how to:

- Create a tracer with `LanternExporter`
- Auto-instrument Anthropic calls with `wrapAnthropicClient()`
- Create custom spans for non-LLM steps
- Attach metadata to traces
- Add evaluation scores via the API

Next: [Set up alerts](../how-to/set-up-alerts.md) | [Monitor costs](../how-to/monitor-costs.md) | [Detect PII](../how-to/detect-pii.md)
