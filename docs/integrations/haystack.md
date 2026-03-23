# Haystack

Trace Haystack pipeline executions, component runs, and LLM calls. Retriever components are automatically identified and traced as `retrieval` spans.

## Installation

```bash
pip install lantern-ai[haystack]
```

This installs `lantern-ai` along with `haystack-ai>=2.0.0` as a dependency.

## Setup

```python
from lantern_ai import LanternTracer
from lantern_ai.collectors.haystack import create_lantern_haystack_handler

tracer = LanternTracer(
    api_key="your-lantern-api-key",
    base_url="https://your-lantern-instance.com",
)

handler = create_lantern_haystack_handler(tracer, agent_name="my-rag-pipeline")
# agent_name is optional, defaults to "haystack-agent"
```

## Usage

### Trace a pipeline execution

```python
from haystack import Pipeline
from haystack.components.retrievers import InMemoryBM25Retriever
from haystack.components.generators import OpenAIGenerator

pipeline = Pipeline()
pipeline.add_component("retriever", InMemoryBM25Retriever(document_store=store))
pipeline.add_component("generator", OpenAIGenerator(model="gpt-4"))
pipeline.connect("retriever", "generator")

# Trace the full pipeline
handler.on_pipeline_start(pipeline_name="rag_pipeline")

# Trace individual components
handler.on_component_start(component_name="retriever", component_type="InMemoryBM25Retriever")
# ... retriever runs ...
handler.on_component_end(component_name="retriever", output="Retrieved 5 documents")

handler.on_component_start(component_name="generator", component_type="OpenAIGenerator")
span_id = handler.on_llm_start(model="gpt-4", messages=[{"role": "user", "content": "..."}])
handler.on_llm_end(span_id=span_id, output="Generated response...", input_tokens=150, output_tokens=200)
handler.on_component_end(component_name="generator", output="Generated response...")

handler.on_pipeline_end(pipeline_name="rag_pipeline", output="Final result...")
handler.finish()
```

### Automatic retriever detection

Components with `"retriever"` in their name are automatically traced as `retrieval` spans instead of `custom` spans:

```python
# This creates a "retrieval" span (name contains "retriever")
handler.on_component_start(component_name="bm25_retriever", component_type="BM25Retriever")

# This creates a "custom" span
handler.on_component_start(component_name="prompt_builder", component_type="PromptBuilder")
```

## What Gets Traced

| Haystack Event | Lantern Span Type | Captured Data |
|----------------|-------------------|---------------|
| `on_pipeline_start` / `on_pipeline_end` | `custom` | Pipeline name, output |
| `on_component_start` / `on_component_end` (retriever) | `retrieval` | Component name, type, output |
| `on_component_start` / `on_component_end` (other) | `custom` | Component name, type, output |
| `on_llm_start` / `on_llm_end` | `llm_call` | Model name, messages, response, token counts |

### Span type inference

The handler checks if the `component_name` (lowercased) contains `"retriever"`. If so, the span type is `retrieval`; otherwise it's `custom`. This heuristic works for all standard Haystack retriever components.

## Troubleshooting

**Pipeline spans not nesting under each other**
- Pipeline and component spans are created at the same level (no automatic parent-child relationship). The trace timeline shows the execution order.

**Retriever not tagged as retrieval**
- The component name must contain `"retriever"` (case-insensitive). If your custom retriever has a different name, it will be tagged as `custom`.

**Component spans not closing**
- Components are tracked by name. Call `on_component_end` with the same `component_name` used in `on_component_start`.

## API Reference

```python
def create_lantern_haystack_handler(
    tracer: LanternTracer,
    *,
    agent_name: str | None = None,
) -> LanternHaystackHandler
```

### LanternHaystackHandler methods

| Method | Parameters | Returns | Description |
|--------|-----------|---------|-------------|
| `on_pipeline_start` | `pipeline_name: str = ""` | `str` (span_id) | Start a pipeline span |
| `on_pipeline_end` | `pipeline_name: str = ""`, `output: str = ""` | `None` | End a pipeline span |
| `on_component_start` | `component_name: str = ""`, `component_type: str = ""` | `str` (span_id) | Start a component span |
| `on_component_end` | `component_name: str = ""`, `output: str = ""` | `None` | End a component span |
| `on_llm_start` | `model: str = ""`, `messages: list = None` | `str` (span_id) | Start an LLM call span |
| `on_llm_end` | `span_id: str`, `output: str = ""`, `input_tokens: int = 0`, `output_tokens: int = 0` | `None` | End an LLM call span |
| `finish` | — | `None` | End the trace |
