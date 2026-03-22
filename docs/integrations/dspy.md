# DSPy

Trace DSPy module predictions, LLM calls, and retriever queries. Captures the full compile-and-predict lifecycle of DSPy programs.

## Installation

```bash
pip install lantern-ai[dspy]
```

This installs `lantern-ai` along with `dspy>=2.5.0` as a dependency.

## Setup

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.dspy import create_lantern_dspy_handler

tracer = LanternTracer(
    api_key="your-lantern-api-key",
    base_url="https://your-lantern-instance.com",
)

handler = create_lantern_dspy_handler(tracer, agent_name="my-dspy-program")
# agent_name is optional, defaults to "dspy-agent"
```

## Usage

### Trace module predictions

```python
import dspy

dspy.configure(lm=dspy.LM("openai/gpt-4"))

class QA(dspy.Module):
    def __init__(self):
        self.predict = dspy.Predict("question -> answer")

    def forward(self, question):
        return self.predict(question=question)

qa = QA()

# Trace the predict call
handler.on_predict_start(module_name="QA.predict", inputs={"question": "What is DSPy?"})
result = qa(question="What is DSPy?")
handler.on_predict_end(module_name="QA.predict", output=result.answer)

handler.finish()
```

### Trace LLM calls

```python
span_id = handler.on_llm_start(
    model="gpt-4",
    messages=[{"role": "user", "content": "What is DSPy?"}],
)

handler.on_llm_end(
    span_id=span_id,
    output="DSPy is a framework for programming with foundation models...",
    input_tokens=12,
    output_tokens=45,
)
```

### Trace retriever calls (RAG pipelines)

```python
span_id = handler.on_retriever_start(query="What is prompt optimization?")
# ... retriever returns documents ...
handler.on_retriever_end(span_id=span_id, output="Retrieved 3 passages about prompt optimization")
```

### Full RAG example

```python
class RAG(dspy.Module):
    def __init__(self):
        self.retrieve = dspy.Retrieve(k=3)
        self.predict = dspy.ChainOfThought("context, question -> answer")

    def forward(self, question):
        context = self.retrieve(question)
        return self.predict(context=context, question=question)

rag = RAG()

handler.on_predict_start(module_name="RAG", inputs={"question": "How does DSPy work?"})
ret_span = handler.on_retriever_start(query="How does DSPy work?")
# ... retriever runs ...
handler.on_retriever_end(span_id=ret_span, output="Retrieved 3 passages")
llm_span = handler.on_llm_start(model="gpt-4", messages=[...])
handler.on_llm_end(span_id=llm_span, output="DSPy works by...", input_tokens=200, output_tokens=150)
handler.on_predict_end(module_name="RAG", output="DSPy works by...")

handler.finish()
```

## What Gets Traced

| DSPy Event | Lantern Span Type | Captured Data |
|-----------|-------------------|---------------|
| `on_predict_start` / `on_predict_end` | `custom` | Module name, inputs, output |
| `on_llm_start` / `on_llm_end` | `llm_call` | Model name, messages, response, token counts |
| `on_retriever_start` / `on_retriever_end` | `retrieval` | Query text, result summary |

### Predict span tracking

Predict spans are tracked by module name (e.g., `"QA.predict"`). If you call the same module multiple times, each new `on_predict_start` with the same name will overwrite the previous span ID — call `on_predict_end` before starting the next prediction with the same module name.

## Troubleshooting

**Predict spans not closing**
- Call `on_predict_end` with the exact same `module_name` used in `on_predict_start`.

**Retriever spans require explicit span_id**
- Unlike predict spans (tracked by name), retriever spans use the `span_id` returned by `on_retriever_start`. Pass this ID to `on_retriever_end`.

**Compiled modules**
- After `dspy.compile()`, the optimized module still calls the same underlying LM. Hook into the compiled module the same way as the original.

## API Reference

```python
def create_lantern_dspy_handler(
    tracer: LanternTracer,
    *,
    agent_name: str | None = None,
) -> LanternDSPyHandler
```

### LanternDSPyHandler methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `on_predict_start` | `module_name: str = ""`, `inputs: Any = None` | `str` (span_id) | Start a predict span |
| `on_predict_end` | `module_name: str = ""`, `output: str = ""` | `None` | End a predict span |
| `on_llm_start` | `model: str = ""`, `messages: list = None` | `str` (span_id) | Start an LLM call span |
| `on_llm_end` | `span_id: str`, `output: str = ""`, `input_tokens: int = 0`, `output_tokens: int = 0` | `None` | End an LLM call span |
| `on_retriever_start` | `query: str = ""` | `str` (span_id) | Start a retrieval span |
| `on_retriever_end` | `span_id: str`, `output: str = ""` | `None` | End a retrieval span |
| `finish` | — | `None` | End the trace |
