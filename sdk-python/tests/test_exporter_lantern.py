"""Tests for LanternExporter — POST, auth header, retry logic (mocked httpx)."""

import json
import pytest
from unittest.mock import MagicMock, patch, PropertyMock

from lantern_ai.exporters.lantern import LanternExporter
from lantern_ai.types import Trace


def _make_trace(**kwargs) -> Trace:
    return Trace(agent_name="bot", **kwargs)


def _mock_response(status_code: int, reason: str = "OK", text: str = "") -> MagicMock:
    resp = MagicMock()
    resp.status_code = status_code
    resp.reason_phrase = reason
    resp.text = text
    return resp


class TestLanternExporterInit:
    def test_strips_trailing_slash(self):
        exp = LanternExporter(endpoint="https://example.com/")
        assert exp._endpoint == "https://example.com"

    def test_stores_api_key(self):
        exp = LanternExporter(endpoint="https://example.com", api_key="sk-123")
        assert exp._api_key == "sk-123"

    def test_exporter_type(self):
        exp = LanternExporter(endpoint="https://example.com")
        assert exp.exporter_type == "lantern"


class TestHeaders:
    def test_auth_header_present(self):
        exp = LanternExporter(endpoint="https://example.com", api_key="sk-abc")
        headers = exp._headers()
        assert headers["Authorization"] == "Bearer sk-abc"
        assert headers["Content-Type"] == "application/json"

    def test_no_api_key_no_auth_header(self):
        exp = LanternExporter(endpoint="https://example.com")
        headers = exp._headers()
        assert "Authorization" not in headers


class TestExport:
    def test_empty_traces_no_request(self):
        exp = LanternExporter(endpoint="https://example.com", api_key="key")
        with patch.object(exp, "_get_client") as mock_client:
            exp.export([])
            mock_client.assert_not_called()

    def test_posts_to_correct_url(self):
        exp = LanternExporter(endpoint="https://example.com", api_key="key", max_retries=0)
        mock_client = MagicMock()
        mock_client.post.return_value = _mock_response(200)
        with patch.object(exp, "_get_client", return_value=mock_client):
            exp.export([_make_trace()])
        call_args = mock_client.post.call_args
        assert call_args[0][0] == "https://example.com/v1/traces"

    def test_posts_json_body(self):
        exp = LanternExporter(endpoint="https://example.com", api_key="key", max_retries=0)
        mock_client = MagicMock()
        mock_client.post.return_value = _mock_response(200)
        with patch.object(exp, "_get_client", return_value=mock_client):
            exp.export([_make_trace()])
        body = mock_client.post.call_args.kwargs.get("content") or mock_client.post.call_args[1].get("content")
        parsed = json.loads(body)
        assert "traces" in parsed
        assert isinstance(parsed["traces"], list)

    def test_raises_on_4xx(self):
        exp = LanternExporter(endpoint="https://example.com", api_key="key", max_retries=0)
        mock_client = MagicMock()
        mock_client.post.return_value = _mock_response(401, "Unauthorized")
        with patch.object(exp, "_get_client", return_value=mock_client):
            with pytest.raises(RuntimeError, match="401"):
                exp.export([_make_trace()])

    def test_retries_on_5xx(self):
        exp = LanternExporter(
            endpoint="https://example.com",
            api_key="key",
            max_retries=2,
            retry_base_delay=0.0,
        )
        mock_client = MagicMock()
        # Fail twice then succeed
        mock_client.post.side_effect = [
            _mock_response(500, "Server Error"),
            _mock_response(500, "Server Error"),
            _mock_response(200),
        ]
        with patch.object(exp, "_get_client", return_value=mock_client):
            with patch.object(exp, "_backoff"):
                exp.export([_make_trace()])
        assert mock_client.post.call_count == 3

    def test_raises_after_max_retries(self):
        exp = LanternExporter(
            endpoint="https://example.com",
            api_key="key",
            max_retries=1,
            retry_base_delay=0.0,
        )
        mock_client = MagicMock()
        mock_client.post.return_value = _mock_response(500, "Server Error")
        with patch.object(exp, "_get_client", return_value=mock_client):
            with patch.object(exp, "_backoff"):
                with pytest.raises(RuntimeError):
                    exp.export([_make_trace()])
        assert mock_client.post.call_count == 2  # initial + 1 retry


class TestShutdown:
    def test_shutdown_closes_client(self):
        exp = LanternExporter(endpoint="https://example.com")
        mock_client = MagicMock()
        exp._client = mock_client
        exp.shutdown()
        mock_client.close.assert_called_once()
        assert exp._client is None

    def test_shutdown_noop_when_no_client(self):
        exp = LanternExporter(endpoint="https://example.com")
        exp.shutdown()  # should not raise
