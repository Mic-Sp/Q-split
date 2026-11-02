"""HTTP and startup checks for the public health probe and engine trust boundary."""

import asyncio
import threading
from unittest.mock import patch

import anyio
import httpx
import pytest
from fastapi.testclient import TestClient

from backend.main import SHOR_SCALES, SimulationRequest, app, create_app


@pytest.fixture(autouse=True)
def local_engine_environment(monkeypatch):
    for variable in ("ENGINE_ENV", "ENGINE_SECRET", "ENGINE_ENABLE_DOCS"):
        monkeypatch.delenv(variable, raising=False)


@pytest.mark.parametrize("scale", [2, 3, 4, 5, 7, 9, 14, 16, 64, 513])
def test_public_shor_rejects_unsupported_moduli_before_dispatch(scale):
    with TestClient(app) as client, patch("backend.main.run_shors_pipeline") as shor:
        response = client.post("/api/simulate", json={"workload_id": "shors_crypto", "scale_param": scale})
    assert response.status_code == 422
    assert "Shor scale_param must be one of" in response.json()["detail"][0]["msg"]
    shor.assert_not_called()


@pytest.mark.parametrize("scale", SHOR_SCALES)
def test_public_shor_preserves_all_supported_presets(scale):
    assert SimulationRequest(workload_id="shors_crypto", scale_param=scale).scale_param == scale


@pytest.mark.parametrize("header", [None, "wrong", "test-engine-secret-extra"])
@pytest.mark.parametrize("environment", ["development", "production"])
def test_configured_secret_rejects_direct_calls_before_execution(monkeypatch, header, environment):
    monkeypatch.setenv("ENGINE_ENV", environment)
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    headers = {} if header is None else {"X-Engine-Secret": header}
    with TestClient(create_app()) as client, patch("backend.main.run_shors_pipeline") as shor, patch(
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
    with TestClient(create_app()) as client:
        assert client.post("/api/simulate", json={"scale_param": 21}).status_code == 200


@pytest.mark.parametrize("secret", [None, "", " \t\n"])
@pytest.mark.parametrize("docs_flag", [None, "1"])
def test_production_without_nonblank_secret_refuses_startup(monkeypatch, secret, docs_flag):
    monkeypatch.setenv("ENGINE_ENV", "production")
    if secret is not None:
        monkeypatch.setenv("ENGINE_SECRET", secret)
    if docs_flag is not None:
        monkeypatch.setenv("ENGINE_ENABLE_DOCS", docs_flag)
    with pytest.raises(RuntimeError, match="ENGINE_SECRET must be set and nonblank"):
        with TestClient(create_app()):
            pytest.fail("A production engine without credentials must not start")


def test_production_secret_is_rechecked_at_lifespan_startup(monkeypatch):
    monkeypatch.setenv("ENGINE_ENV", "production")
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    engine = create_app()
    monkeypatch.delenv("ENGINE_SECRET")
    with pytest.raises(RuntimeError, match="ENGINE_SECRET must be set and nonblank"):
        with TestClient(engine):
            pytest.fail("Removing credentials before startup must not bypass validation")


@pytest.mark.parametrize("environment", ["development", "production"])
@pytest.mark.parametrize("docs_flag", [None, "0", "1", "true"])
def test_docs_policy_is_independent_of_public_health(monkeypatch, environment, docs_flag):
    monkeypatch.setenv("ENGINE_ENV", environment)
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    if docs_flag is not None:
        monkeypatch.setenv("ENGINE_ENABLE_DOCS", docs_flag)
    enabled = environment != "production" or docs_flag == "1"
    with TestClient(create_app()) as client:
        for path in ("/docs", "/docs/oauth2-redirect", "/redoc", "/openapi.json"):
            assert client.get(path).status_code == (200 if enabled else 404)
        assert client.get("/").status_code == 200
        assert client.get("/", headers={"X-Engine-Secret": "wrong"}).status_code == 200
        assert client.post("/api/simulate", json={"scale_param": 21}).status_code == 401
        assert client.post("/api/simulate", json={"scale_param": 21},
                           headers={"X-Engine-Secret": "test-engine-secret"}).status_code == 200


def test_production_secret_loss_fails_closed_without_blocking_health(monkeypatch):
    monkeypatch.setenv("ENGINE_ENV", "production")
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    with TestClient(create_app()) as client, patch("backend.main.run_shors_pipeline") as shor:
        monkeypatch.delenv("ENGINE_SECRET")
        response = client.post("/api/simulate", json={"scale_param": 21})
        assert response.status_code == 503
        assert response.json() == {"detail": "Engine authentication is not configured."}
        assert client.get("/").status_code == 200
        shor.assert_not_called()


def test_engine_grants_no_browser_cors_preflight(monkeypatch):
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    with TestClient(app) as client:
        response = client.options("/api/simulate", headers={
            "Origin": "https://untrusted.example", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-engine-secret",
        })
        assert "access-control-allow-origin" not in response.headers


@pytest.mark.parametrize("environment", ["development", "production"])
def test_health_is_public_uncached_and_does_not_execute_workloads(monkeypatch, environment):
    monkeypatch.setenv("ENGINE_ENV", environment)
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    with TestClient(create_app()) as client, patch("backend.main.execute_live_shors_15") as shor, patch(
        "backend.main.execute_live_quantum_mips_64"
    ) as mips:
        response = client.get("/")
        assert response.status_code == 200
        assert response.json() == {"status": "online", "engine": "Q-Split Hybrid Profiler v2.0"}
        assert response.headers["cache-control"] == "no-store"
        shor.assert_not_called()
        mips.assert_not_called()


@pytest.mark.parametrize("environment", ["development", "production"])
def test_health_does_not_wait_for_a_busy_simulation_worker(monkeypatch, environment):
    monkeypatch.setenv("ENGINE_ENV", environment)
    monkeypatch.setenv("ENGINE_SECRET", "test-engine-secret")
    engine = create_app()

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
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=engine, raise_app_exceptions=False),
                                         base_url="http://engine") as client:
                with patch("backend.main.run_shors_pipeline", side_effect=busy_simulation):
                    simulation = asyncio.create_task(client.post("/api/simulate", json={"scale_param": 21},
                                                                headers={"X-Engine-Secret": "test-engine-secret"}))
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
