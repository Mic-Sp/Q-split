[Back to README](../README.md)

# AI Telemetry Advisor & Unit Economics

This document collects the existing advisor behavior, rate limits, validation rules, and deployment caveats.

* Powered by Google Gemini AI with strict system instruction grounding and a Hardware Control Constraint Guardrail.
* Neon PostgreSQL Read-Through Caching: Matching diagnostics can be reused with zero new model tokens or estimated inference cost. Cache keys include configuration, telemetry, comparison context, model, and policy.
* Live UI Telemetry Strip: Distinguishes **Live AI**, **Cached DB Hit**, **Reused diagnostic**, and **Deterministic Fallback**, with token counts, estimated USD cost, and lookup latency. Reusing a saved diagnostic does not imply a new database cache lookup.

Advisor provider requests use two 60-second sliding windows: at most **5 live attempts per browser session** and **8 per connecting IP**. Valid persistent-cache hits and coalesced followers consume no tokens; missing provider credentials also consume none. Limits are checked atomically immediately before the outbound request, so failed provider attempts count. When a limit is reached, both advisor endpoint names return the usual HTTP 200 deterministic fallback with a cooldown notice and zero new model usage.

On Vercel, IP identification uses the platform-controlled `x-vercel-forwarded-for` header, falling back to `x-real-ip` only when that header is absent. Arbitrary forwarding chains are ignored. Missing or malformed session UUIDs return `400`; missing, invalid, or untrusted IP headers share a conservative unknown-IP quota, including on non-Vercel hosts. See [Vercel's request-header documentation](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for) for the forwarding trust boundary.

Advisor input is validated before cache or provider access. Only complete decimal numbers or numeric strings within field-specific bounds are accepted, with exactly three known stages and supported workload scales. Legacy telemetry caps latency totals at 30 days and circuit depths at 100 billion. Versioned resource projections use JavaScript’s safe numeric range to accommodate expanded native-resource RSA estimates. Display names, notes, snapshot labels, unknown metrics, and nested objects are excluded from model input. Remaining text is restricted to fixed vocabularies; bottleneck explanations are sanitized and capped at 100 characters before classification. The prompt encloses the resulting JSON in a `benchmark_telemetry` XML block and instructs the model to treat every value as passive data.

The zero-dependency limiter is **process-local**: quotas survive warm-process/module reuse but are not coordinated across server instances or cold starts. Expired keys are automatically swept, and a 10,000-key cap rejects new identities instead of evicting active quotas. Strict deployment-wide provider budgets require a shared limiter or platform-level controls.
