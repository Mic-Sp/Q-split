[Back to README](../README.md)

# Deployment

This document collects the existing engine credentials, health-probe, cold-start, production, and Docker instructions.

## Cold starts

The hosted backend on Render may take 30–50 seconds or longer to spin up after inactivity. Keep the page open while the initial request completes; [Render documents free-service startup as taking about a minute](https://render.com/docs/free#spinning-down-on-idle).

## Engine credentials and health probe

   Set the same nonempty `ENGINE_SECRET` in the FastAPI process environment and the Next.js server environment (locally, `frontend/.env.local`) to authenticate simulations. The proxy sends it as `X-Engine-Secret`; missing or incorrect credentials receive HTTP 401 before simulation dispatch. Without `ENGINE_ENV=production`, an unset or blank secret keeps local development open. Production requires a nonblank secret and refuses to start without one; see [production deployment](#production-deployment). Engine routes grant no browser CORS access because browsers use the Next.js proxy. Keep the secret out of `NEXT_PUBLIC_*` variables.

   `GET /` is a public, uncached health probe in both development and configured production. It needs no secret, stays available when docs are disabled, performs no simulation, and does not wait for simulation worker threads. Each Next.js Node server startup pings it once with a three-second timeout; engine downtime does not fail frontend startup. Each page mount also sends a non-blocking `GET /api/health` through Next.js to that probe with `cache: "no-store"`. The header shows a wake-up message until the engine responds, then “Engine connected”; a simulation pending for more than three seconds shows a cold-start notice. The proxy allows up to 60 seconds for the health check; simulation requests retain their existing timeout and controls stay usable while the engine wakes.

## Production deployment

Set these variables in the **FastAPI process environment** before starting the engine:

| Variable | Production behavior |
| --- | --- |
| `ENGINE_ENV=production` | Requires a nonblank `ENGINE_SECRET` during app creation and startup. |
| `ENGINE_SECRET` | Supply through the hosting platform's secret configuration; set the same value on the Next.js server. Missing or whitespace-only values prevent startup. |
| `ENGINE_ENABLE_DOCS` | Leave unset to disable `/docs`, `/docs/oauth2-redirect`, `/redoc`, and `/openapi.json`. Set exactly `1` to expose them; simulation requests still require the secret. |

On Next.js, set `SIMULATION_API_URL` to the engine URL and `ENGINE_SECRET` to the matching value. `ENGINE_ENV` and `ENGINE_ENABLE_DOCS` belong to FastAPI, not the browser. Restart the engine after changing these settings. Local Python development without the production flag keeps optional authentication and docs enabled. If a running production process loses its secret, simulation requests fail closed with HTTP 503.

The backend Dockerfile defaults to `ENGINE_ENV=production`. With `ENGINE_SECRET` supplied in the host environment, build and run it from the repository root:

```sh
docker build -t q-split-engine backend
docker run --rm -p 8000:8000 -e ENGINE_SECRET q-split-engine
```

For an intentionally open local container, pass `-e ENGINE_ENV=development`. Configure platform health checks and Next.js pre-warming to use **`GET /`**. It remains public without `X-Engine-Secret`, independently of authentication and docs visibility. A production process with missing credentials must be configured correctly before it can start serving any routes.
