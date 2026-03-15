# Getting Started with Lantern

Get from zero to seeing your first trace in under five minutes. Pick **one** path below and follow it through.

---

## Prerequisites

- A Lantern account — sign up at [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev)
- An API key — create one in **Settings > API Keys** after signing up

> **Note:** If you are self-hosting, see the [self-hosting tutorial](./tutorials/self-hosting.md) first, then return here.

---

## Path A: TypeScript SDK (Node.js)

### 1. Create a project and install dependencies

```bash
mkdir lantern-quickstart && cd lantern-quickstart
npm init -y
npm install @lantern-ai/sdk @anthropic-ai/sdk
```

### 2. Set your environment variables

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LANTERN_API_KEY="ltn_..."
```

### 3. Create `agent.ts`

```typescript
import Anthropic from "@anthropic-ai/sdk";
import {
  LanternTracer,
  LanternExporter,
  wrapAnthropicClient,
} from "@lantern-ai/sdk";

// 1. Create a tracer that exports to Lantern
const tracer = new LanternTracer({
  serviceName: "quickstart-agent",
  environment: "development",
  exporter: new LanternExporter({
    endpoint: "https://ingest.openlanternai.com",
    apiKey: process.env.LANTERN_API_KEY,
  }),
});

// 2. Wrap the Anthropic client — all calls are now traced automatically
const anthropic = wrapAnthropicClient(new Anthropic(), tracer);

// 3. Make an LLM call
const response = await anthropic.messages.create({
  model: "claude-sonnet-4-5-20251001",
  max_tokens: 256,
  messages: [
    {
      role: "user",
      content: "Classify this support ticket: 'My invoice is wrong'. Reply with one word: billing, technical, or general.",
    },
  ],
});

console.log("Response:", response.content[0].text);

// 4. Flush traces and shut down
await tracer.shutdown();
console.log("Trace sent to Lantern.");
```

### 4. Run it

```bash
npx tsx agent.ts
```

You should see:

```
Response: billing
Trace sent to Lantern.
```

### 5. View the trace

Open [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev). Your trace appears under **Traces** within a few seconds. Click it to see the full reasoning chain, token counts, and cost.

---

## Path B: Python SDK

### 1. Create a project and install dependencies

```bash
mkdir lantern-quickstart && cd lantern-quickstart
python -m venv .venv
source .venv/bin/activate
pip install lantern-ai anthropic
```

### 2. Set your environment variables

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LANTERN_API_KEY="ltn_..."
```

### 3. Create `agent.py`

```python
import os
from anthropic import Anthropic
from lantern_ai import LanternTracer, wrap_anthropic_client

# 1. Create a tracer that exports to Lantern
tracer = LanternTracer(
    service_name="quickstart-agent",
    environment="development",
    api_key=os.environ["LANTERN_API_KEY"],
    endpoint="https://ingest.openlanternai.com",
)

# 2. Wrap the Anthropic client — all calls are now traced automatically
client = Anthropic()
wrap_anthropic_client(client, tracer)

# 3. Make an LLM call
response = client.messages.create(
    model="claude-sonnet-4-5-20251001",
    max_tokens=256,
    messages=[
        {
            "role": "user",
            "content": "Classify this support ticket: 'My invoice is wrong'. Reply with one word: billing, technical, or general.",
        }
    ],
)

print("Response:", response.content[0].text)

# 4. Flush traces and shut down
tracer.shutdown()
print("Trace sent to Lantern.")
```

### 4. Run it

```bash
python agent.py
```

You should see:

```
Response: billing
Trace sent to Lantern.
```

### 5. View the trace

Open [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev). Your trace appears under **Traces** within a few seconds.

---

## Path C: LLM Proxy (any language, zero code changes)

The LLM Proxy sits between your agent and the LLM API. No SDK required — just change a URL.

### 1. Set environment variables

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export LANTERN_API_KEY="ltn_..."
```

### 2. Point your client at the proxy

Instead of calling `api.anthropic.com` directly, set the base URL to the Lantern proxy:

```bash
export ANTHROPIC_BASE_URL="https://proxy.openlanternai.com/anthropic"
```

### 3. Add the Lantern API key header

Your HTTP requests need one extra header:

```
X-Lantern-Api-Key: ltn_...
```

Here is a complete example with `curl`:

```bash
curl -X POST https://proxy.openlanternai.com/anthropic/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: $ANTHROPIC_API_KEY" \
  -H "X-Lantern-Api-Key: $LANTERN_API_KEY" \
  -H "X-Lantern-Service: quickstart-agent" \
  -H "anthropic-version: 2023-06-01" \
  -d '{
    "model": "claude-sonnet-4-5-20251001",
    "max_tokens": 256,
    "messages": [
      {"role": "user", "content": "Classify this support ticket: '\''My invoice is wrong'\''. Reply with one word: billing, technical, or general."}
    ]
  }'
```

Or in Python with the Anthropic SDK — no Lantern SDK needed:

```python
import os
from anthropic import Anthropic

client = Anthropic(
    base_url="https://proxy.openlanternai.com/anthropic",
    default_headers={
        "X-Lantern-Api-Key": os.environ["LANTERN_API_KEY"],
        "X-Lantern-Service": "quickstart-agent",
    },
)

response = client.messages.create(
    model="claude-sonnet-4-5-20251001",
    max_tokens=256,
    messages=[
        {"role": "user", "content": "Classify this support ticket: 'My invoice is wrong'. Reply with one word: billing, technical, or general."}
    ],
)

print("Response:", response.content[0].text)
```

### 4. View the trace

Open [openlanternai-dashboard.pages.dev](https://openlanternai-dashboard.pages.dev). Every request through the proxy generates a trace automatically.

---

## Next steps

- [Instrument a TypeScript agent in depth](./tutorials/instrument-typescript.md)
- [Instrument a Python agent in depth](./tutorials/instrument-python.md)
- [Use the LLM Proxy](./how-to/use-llm-proxy.md)
- [Self-host Lantern with Docker Compose](./tutorials/self-hosting.md)
- [Set up alerts](./how-to/set-up-alerts.md)
- [Monitor costs](./how-to/monitor-costs.md)
