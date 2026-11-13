// Run against a production preview; needs Playwright and a local backend venv.
// PLAYWRIGHT_MODULE and CHROMIUM_EXECUTABLE can point at an existing installation.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../../", import.meta.url));
const url = process.env.PREVIEW_URL || "http://127.0.0.1:3107";
function simulate(request) {
  const output = spawnSync(resolve(root, "backend/venv/bin/python"), ["-c", "import sys; from backend.main import SimulationRequest, simulate_workload; print(simulate_workload(SimulationRequest.model_validate_json(sys.stdin.read())).model_dump_json())"], { cwd: root, input: JSON.stringify(request), encoding: "utf8", timeout: 20000 });
  assert.equal(output.status, 0, output.stderr); return JSON.parse(output.stdout);
}
function savedRecord(run) {
  const { request, telemetry } = run, m = telemetry.stages.stage_2_quantum_kernel.metrics;
  return { ...run, createdAt: run.completedAt, workloadId: request.workload_id, workloadName: telemetry.workload_name,
    scaleParam: request.scale_param, scaleLabel: telemetry.scale_label, hardwareProfile: request.hardware_profile,
    stage1Node: request.routing.stage_1_node, stage2Node: request.routing.stage_2_node, stage3Node: request.routing.stage_3_node,
    executionMode: telemetry.execution_mode, totalLatencyMs: Object.values(telemetry.stages).reduce((sum, stage) => sum + stage.latency_ms, 0),
    bottleneckStatus: telemetry.stages.stage_2_quantum_kernel.status, primaryBottleneck: telemetry.primary_bottleneck,
    qubitsRequired: m.qubits_required, circuitDepth: String(m.circuit_depth), coherenceSurvivalPct: m.coherence_survival_pct,
    advisorInsight: run.advisorInsight ?? null, snapshotName: null, isSnapshot: false, snapshotUpdatedAt: null };
}
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}), args: ["--no-sandbox"] });
try {
  for (const width of process.env.BROWSER_WIDTHS ? process.env.BROWSER_WIDTHS.split(",").map(Number) : [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [], requests = [], responses = [], saved = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/health", route => route.fulfill({ json: { status: "online" } }));
    await page.route("**/api/advisor", route => route.fulfill({ status: 503, json: {} }));
    await page.route("**/api/runs**", route => {
      if (route.request().method() === "GET") return route.fulfill({ json: { status: "ready", runs: saved, snapshots: [] } });
      const record = savedRecord(route.request().postDataJSON());
      const index = saved.findIndex(item => item.id === record.id);
      if (index >= 0) saved[index] = record; else saved.unshift(record);
      return route.fulfill({ json: { status: "saved", run: record } });
    });
    await page.route("**/api/simulate", route => {
      const request = route.request().postDataJSON(); requests.push(request);
      const response = simulate(request); responses.push(response); return route.fulfill({ json: response });
    });
    await page.goto(url, { waitUntil: "networkidle" });
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('[aria-label="Simulation controls"] > div')).display), "grid", "Production preview must include compiled Tailwind utilities.");
    await page.locator("#hardware-profile").selectOption("custom");
    await page.getByRole("button", { name: "N = 21", exact: true }).click();
    const baseline = async () => {
      await page.getByLabel("Clone baseline from").selectOption("ibm_nighthawk_r2");
      await page.getByRole("button", { name: "Clone baseline", exact: true }).click();
      await page.getByLabel("2Q error probability", { exact: true }).fill("0.001");
    };
    const run = async () => {
      const finished = page.waitForResponse(response => response.url().endsWith("/api/simulate"));
      await page.getByRole("button", { name: "Run simulation", exact: true }).click(); await finished;
      await page.getByRole("button", { name: "Run simulation", exact: true }).waitFor({ state: "visible" });
      await page.getByLabel("Inverse hardware design", { exact: true }).waitFor();
    };
    await baseline(); await run();
    const source = structuredClone(requests.at(-1));
    const panel = page.getByLabel("Inverse hardware design", { exact: true });
    await panel.getByRole("button", { name: "Apply Target Recipe to Custom Profile", exact: true }).waitFor();
    await page.getByRole("button", { name: "Generate analysis", exact: true }).click();
    await page.getByText("Local deterministic diagnostic", { exact: true }).waitFor();
    assert.match(await page.getByLabel("AI Telemetry Advisor", { exact: true }).textContent(), /50% per-shot T1 point/);
    // Dirty live controls must not alter the completed circuit used by Apply.
    await page.getByRole("button", { name: "N = 15", exact: true }).click();
    await page.locator("#available-qubits").fill("16");
    await page.getByLabel("2Q error probability", { exact: true }).fill("0.2");
    await panel.getByRole("button", { name: "Apply Target Recipe to Custom Profile", exact: true }).click();
    assert.equal(await page.locator("#available-qubits").inputValue(), String(source.available_qubits));
    await run();
    assert.equal(requests.at(-1).scale_param, 21);
    assert.deepEqual(requests.at(-1).routing, source.routing);
    assert(Math.abs(responses.at(-1).stages.stage_2_quantum_kernel.metrics.coherence_survival_pct - 50) < 1e-8);
    await panel.getByLabel("Inverse design survival target").selectOption("0.8");
    await panel.getByRole("button", { name: "Apply Target Recipe to Custom Profile", exact: true }).click();
    await run();
    assert(Math.abs(responses.at(-1).stages.stage_2_quantum_kernel.metrics.coherence_survival_pct - 80) < 1e-8);
    await baseline(); await run();
    const surface = panel.getByRole("button", { name: /^Apply Recommended d=\d+ FTQC Config$/ });
    await surface.click();
    assert.equal(await page.getByLabel("Logical FTQC mode", { exact: true }).isChecked(), true);
    assert.equal(await page.getByLabel("Routing topology factor").inputValue(), "1");
    await run();
    const profile = requests.at(-1).custom_profile;
    assert(profile.surface_code?.code_distance_d % 2 === 1);
    assert.equal(profile.t1_us, null); assert.equal(profile.t2_us, null);
    assert.equal(profile.n_physical_qubits, 2 * profile.surface_code.code_distance_d ** 2 * source.available_qubits);
    assert(responses.at(-1).stages.stage_2_quantum_kernel.metrics.coherence_survival_pct >= 50 - 1e-8);
    const overflow = await page.evaluate(() => [...document.querySelectorAll("body *")].filter(element => element.getBoundingClientRect().right > window.innerWidth + 1 && element.getBoundingClientRect().width > 0).map(element => ({ tag: element.tagName, class: element.className, text: element.textContent?.slice(0, 100), right: element.getBoundingClientRect().right })).slice(0, 12));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, JSON.stringify(overflow));
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ width, balanced50: true, balanced80: true, restoredDirtyControls: true,
      offlineAdvisor: true, surfaceDistance: profile.surface_code.code_distance_d, surfaceSurvivalPct: responses.at(-1).stages.stage_2_quantum_kernel.metrics.coherence_survival_pct, runtimeErrors: errors }));
    await page.close();
  }
} finally { await browser.close(); }
