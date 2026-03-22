from .anthropic import wrap_anthropic_client
from .openai import wrap_openai_client
from .crewai import create_lantern_crewai_handler
from .pydantic_ai import create_lantern_pydantic_handler
from .autogen import create_lantern_autogen_handler
from .haystack import create_lantern_haystack_handler
from .dspy import create_lantern_dspy_handler
from .smolagents import create_lantern_smolagents_handler

__all__ = [
    "wrap_anthropic_client", "wrap_openai_client",
    "create_lantern_crewai_handler", "create_lantern_pydantic_handler",
    "create_lantern_autogen_handler", "create_lantern_haystack_handler",
    "create_lantern_dspy_handler", "create_lantern_smolagents_handler",
]
