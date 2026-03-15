"""LanternExporter -- sends traces to the Lantern ingest API via HTTP."""

from __future__ import annotations

import time
from typing import Any, Dict, List, Optional

from .base import TraceExporter
from ..types import Trace


class LanternExporter(TraceExporter):
    """Exports traces to a Lantern ingest backend via HTTP POST.

    Supports batching and exponential-backoff retry on 5xx / network errors.

    Parameters
    ----------
    endpoint:
        Base URL of the Lantern ingest service (e.g.
        ``"https://ingest.openlanternai.com"``).
    api_key:
        Bearer token for the ``Authorization`` header.
    max_retries:
        Number of retries on transient failures (default 3).
    retry_base_delay:
        Base delay in seconds for exponential backoff (default 1.0).
    """

    def __init__(
        self,
        endpoint: str,
        api_key: Optional[str] = None,
        *,
        max_retries: int = 3,
        retry_base_delay: float = 1.0,
    ) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._max_retries = max_retries
        self._retry_base_delay = retry_base_delay
        self._client: Optional[Any] = None  # lazy httpx.Client
        self._async_client: Optional[Any] = None  # lazy httpx.AsyncClient

    @property
    def exporter_type(self) -> str:
        return "lantern"

    # -- Helpers -------------------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        headers: Dict[str, str] = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        return headers

    def _backoff(self, attempt: int) -> None:
        delay = self._retry_base_delay * (2 ** attempt)
        time.sleep(delay)

    async def _async_backoff(self, attempt: int) -> None:
        import asyncio

        delay = self._retry_base_delay * (2 ** attempt)
        await asyncio.sleep(delay)

    def _get_client(self) -> Any:
        if self._client is None:
            import httpx

            self._client = httpx.Client(timeout=30.0)
        return self._client

    def _get_async_client(self) -> Any:
        if self._async_client is None:
            import httpx

            self._async_client = httpx.AsyncClient(timeout=30.0)
        return self._async_client

    # -- Sync export ---------------------------------------------------------

    def export(self, traces: List[Trace]) -> None:
        """Send traces to ``POST {endpoint}/v1/traces``."""
        if not traces:
            return

        import json

        url = f"{self._endpoint}/v1/traces"
        body = json.dumps({"traces": [t.to_dict() for t in traces]})
        client = self._get_client()

        last_error: Optional[Exception] = None

        for attempt in range(self._max_retries + 1):
            try:
                response = client.post(url, content=body, headers=self._headers())

                if response.status_code < 300:
                    return

                # Retry on 5xx
                if response.status_code >= 500 and attempt < self._max_retries:
                    self._backoff(attempt)
                    continue

                raise RuntimeError(
                    f"Lantern ingest failed: {response.status_code} "
                    f"{response.reason_phrase} - {response.text}"
                )
            except Exception as exc:
                last_error = exc
                # Retry on connection errors
                if attempt < self._max_retries:
                    self._backoff(attempt)
                    continue
                raise

    # -- Async export --------------------------------------------------------

    async def export_async(self, traces: List[Trace]) -> None:
        """Async variant -- sends traces via ``httpx.AsyncClient``."""
        if not traces:
            return

        import json

        url = f"{self._endpoint}/v1/traces"
        body = json.dumps({"traces": [t.to_dict() for t in traces]})
        client = self._get_async_client()

        for attempt in range(self._max_retries + 1):
            try:
                response = await client.post(url, content=body, headers=self._headers())

                if response.status_code < 300:
                    return

                if response.status_code >= 500 and attempt < self._max_retries:
                    await self._async_backoff(attempt)
                    continue

                raise RuntimeError(
                    f"Lantern ingest failed: {response.status_code} "
                    f"{response.reason_phrase} - {response.text}"
                )
            except Exception as exc:
                if attempt < self._max_retries:
                    await self._async_backoff(attempt)
                    continue
                raise

    # -- Shutdown ------------------------------------------------------------

    def shutdown(self) -> None:
        if self._client is not None:
            self._client.close()
            self._client = None

    async def shutdown_async(self) -> None:
        if self._async_client is not None:
            await self._async_client.aclose()
            self._async_client = None
        if self._client is not None:
            self._client.close()
            self._client = None
