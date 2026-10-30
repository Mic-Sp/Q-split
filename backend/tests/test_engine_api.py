"""HTTP checks for the public health probe and optional engine trust boundary."""

import asyncio
import threading
from unittest.mock import patch

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import app


@pytest.mark.parametrize("header", [None, "wrong", "test-engine-secret-extra"])
def test_configured_secret_rejects_direct_calls_before_execution(monkeypatch, header):
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    headers = {} if header is None else {"X-Engine-Secret": header}
    with TestClient(app) as client, patch("backend.main.run_shors_pipeline") as shor, patch(
        "backend.main.run_quantum_mips_pipeline"
    ) as mips:
        for workload in ["shors_crypto", "quantum_mips"]:
            response = client.post("/api/simulate", json={"workload_id": workload}, headers=headers)
            assert response.status_code == 401
            assert response.json() == {"detail": "Invalid engine credentials."}
        shor.assert_not_called()
        mips.assert_not_called()


@pytest.mark.parametrize("origin", [None, "http://localhost:3000", "https://untrusted.example"])
def test_secret_authentication_does_not_depend_on_origin(monkeypatch, origin):
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    headers = {"Origin": origin} if origin else {}
    with TestClient(app) as client:
        assert client.post("/api/simulate", json={"scale_param": 21}, headers=headers).status_code == 401
        response = client.post("/api/simulate", json={"scale_param": 21},
                               headers={**headers, "X-Engine-Secret": "test-engine-secret"})
        assert response.status_code == 200
        assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("secret", [None, "", "   "])
def test_optional_secret_preserves_local_development(monkeypatch, secret):
    if secret is None:
        monkeypatch.delenv("ENGINE_SECRET", raising=False)
    else:
        monkeypatch.setenv("ENGINE_SECRET", secret)
    with TestClient(app) as client:
        assert client.post("/api/simulate", json={"scale_param": 21}).status_code == 200


def test_engine_grants_no_browser_cors_preflight(monkeypatch):
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    with TestClient(app) as client:
        response = client.options("/api/simulate", headers={
            "Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-engine-secret",
        })
        assert "access-control-allow-origin" not in response.headers


def test_health_is_public_uncached_and_does_not_execute_workloads(monkeypatch):
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    with TestClient(app) as client, patch("backend.main.execute_live_shors_15") as shor, patch(
        "backend.main.execute_live_quantum_mips_64"
    ) as mips:
        response = client.get("/")
        assert response.status_code == 200
        assert response.json() == {"status": "online", "engine": "Q-Split Hybrid Profiler v2.0"}
        assert response.headers["cache-control"] == "no-store"
        shor.assert_not_called()
        mips.assert_not_called()


def test_health_does_not_wait_for_a_busy_simulation_worker(monkeypatch):
    monkeypatch.delenv("ENGINE_SECRET", raising=False)

    async def check():
        limiter = anyio.to_thread.current_default_thread_limiter()
        previous_limit = limiter.total_tokens
        limiter.total_tokens = 1
        started = anyio.Event()
        release = threading.Event()

        def busy_simulation(*args):
            anyio.from_thread.run_sync(started.set)
            release.wait(timeout=5)
            raise RuntimeError("test worker released")

        try:
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app, raise_app_exceptions=False),
                                         base_url="http://engine") as client:
                with patch("backend.main.run_shors_pipeline", side_effect=busy_simulation):
                    simulation = asyncio.create_task(client.post("/api/simulate", json={"scale_param": 21}))
                    try:
                        await asyncio.wait_for(started.wait(), timeout=2)
                        health = await asyncio.wait_for(client.get("/"), timeout=1)
                        assert health.status_code == 200
                    finally:
                        release.set()
                        await simulation
        finally:
            limiter.total_tokens = previous_limit

    asyncio.run(check())
