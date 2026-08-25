from unittest.mock import AsyncMock, MagicMock, patch

from httpx import AsyncClient


async def test_ai_health_exposes_runtime_status_without_secrets(client: AsyncClient):
    response_mock = MagicMock()
    response_mock.raise_for_status.return_value = None
    http_client = AsyncMock()
    http_client.get.return_value = response_mock
    context = AsyncMock()
    context.__aenter__.return_value = http_client

    with patch("src.main.httpx.AsyncClient", return_value=context):
        response = await client.get("/health/ai")

    assert response.status_code == 200
    data = response.json()
    assert data["local_reachable"] is True
    assert data["circuit"]["state"] in {"closed", "open"}
    assert set(data["metrics"]) == {"local", "flash", "pro"}
    assert data["roles"]["interactive"]["primary"] == "local"
    assert data["roles"]["structured"]["primary"] == "cloud"
    assert data["roles"]["critical"]["primary"] == "cloud-pro"
    assert data["roles"]["embedding"]["primary"] == "embedding-local"
    assert "api_key" not in str(data).lower()
