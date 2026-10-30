# 🧪 Q-Split — Quickstart Guide for Classmates

**Live App:** [https://q-split.vercel.app/](https://q-split.vercel.app/)

For local installation, environment variables, and test commands, see [README.md](README.md).

## What are you looking at?

**Q-Split** is a hybrid **CPU + GPU + Quantum (QPU)** simulator and profiler.

Routing and hardware timings are modeled estimates. The app runs small reference circuits in the Qiskit Aer simulator and uses analytical projections for other configurations; it does not dispatch work to physical QPUs or run a production vector database search.

Quantum computers aren't meant to replace your whole computer—they act like specialized co-processors (similar to a GPU) for specific math bottlenecks. Every workload in Q-Split is split into a **3-Stage Execution Pipeline**:

1. **Stage 01 (Classical Pre-processing):** Prepares and filters the data (`CPU` or `GPU`).
2. **Stage 02 (Quantum Kernel):** Runs the heavy quantum algorithm (`QPU`, or emulated in `CPU`/`GPU` RAM).
3. **Stage 03 (Classical Post-processing):** Verifies and formats the final answer (`CPU` or `GPU`).

Your goal is to find the best hardware combo (`CPU`, `GPU`, or `QPU`) without running out of memory, getting slowed down by data-transfer cables (PCIe/interconnect overhead), or losing your quantum state to hardware noise (**Decoherence**).

---

## 🕹️ How to Use the Controls (Top Panel)

1. **`01 / WORKLOAD PRESET` — Pick a Problem:**
   * **Shor's Algorithm:** Explore factoring demonstrations and projected resource requirements (`N = 15` up to `RSA-2048`). RSA-scale runs do not factor real encryption keys.
   * **Quantum-MIPS (Maximum Inner Product Search):** Explore a model of LLM vector retrieval (`M = 64` up to `1M` candidates), using Grover's search / amplitude amplification with $O(\sqrt{M})$ iterations. The small Aer circuit amplifies a fixed marked index; it does not load vectors or execute adaptive maximum finding.
2. **`02 / TARGET SCALE` — Pick the Problem Size:**
   * Hover over any button to see what it does! 
   * *Note:* N = 15 and M = 64 sequential references execute in Qiskit Aer; other tiers and larger scales use analytical projections. Select the **Sequential** tier to explore the base-scale Aer reference. Measured simulator timing is separate from projected GPU/QPU timing and coherence.
3. **`03 / HARDWARE PROFILE` — Pick a Hardware Model:**
   * **IBM Heron NISQ:** 133-qubit r1 reference with superconducting gates and sparse Heavy-Hex connectivity.
   * **Google Weber (2D Grid):** An exploratory 72-qubit grid preset. The published Weber physical device has 53 active qubits; this preset's capacity is an exploratory model setting.
   * **IonQ Forte (Trapped Ion):** 36-qubit reference with high gate fidelity, long coherence, and all-to-all connectivity. Laser-driven gates are slower in the model; high fidelity does not mean noise-free execution.
   * **Ideal Noise-Free:** Theoretical reference with 100% modeled coherence for feasible execution. Capacity and routing limits still apply.
4. **`04 / AVAILABLE QPU QUBITS` & `TIERS` — Trade Space for Speed:**
   * More available qubits unlock **Parallel Tiers** (`Sequential` $\rightarrow$ `Windowed` $\rightarrow$ `Carry-Lookahead / Multi-Oracle`) with shallower modeled circuits. Qubits above the workload's ceiling remain idle. Capacity overrides beyond a profile's reference are exploratory, not additional physical device qubits.

Use the header's **Sun/Moon** button for light or dark mode, or the **monitor** button to follow your system preference. System mode is the default, and your choice persists across reloads.

---

## 🔥 3 Cool Experiments to Try Right Now

### Experiment 1: Model GPU Launch/Transfer Overhead

1. Keep **Shor's Algorithm** at **`N = 15`** on **IBM Heron NISQ**.
2. Scroll slightly to the **Execution pipeline** cards (`STAGE 01`, `STAGE 02`, `STAGE 03`).
3. Switch **Stage 01** from `CPU` to `GPU` and click **Run simulation**.
4. **What happens:** Stage 01 reports `WARNING`. For this small scalar workload, the modeled `0.30 ms` GPU launch/transfer penalty outweighs its compute savings.

### Experiment 2: Compare GPU Host Stages and QPU Profiles

1. Change `01 / WORKLOAD PRESET` to **Quantum-MIPS** and select **`M = 128k (LLM Vocab)`**.
2. Set the pipeline route to **`GPU` $\rightarrow$ `QPU` $\rightarrow$ `GPU`** and click **Run simulation**.
3. **What happens:** GPU host stages report `OPTIMAL` because their modeled compute savings amortize the launch/transfer cost at this scale. The QPU stage can still exceed its coherence budget, so host-stage status alone does not establish an offload advantage.
4. Switch `03 / HARDWARE PROFILE` between **IBM Heron NISQ** and **IonQ Forte (Trapped Ion)**. After each profile change, set **Available QPU Qubits** to `36` to compare equal-capacity registers, then run again. This fits the sequential register at this scale and exposes the modeled trade-off between gate latency and coherence; it does not guarantee a viable QPU run.

### Experiment 3: Break Classical RAM, Then Ask the AI Advisor

1. Select **Shor's Algorithm** $\rightarrow$ **`RSA-512`**.
2. In **Stage 02**, switch `RUN ON` from `QPU` to **`CPU`** or **`GPU`** and click **Run simulation**.
3. **What happens:** The pipeline hits a **Critical Bottleneck**. A 1,027-qubit statevector requires $16 \times 2^{1027}$ bytes of RAM: 16 bytes per complex amplitude. This exceeds both the modeled 16 GiB CPU and 8 GiB GPU budgets.
4. Click **Generate analysis** inside the **AI Telemetry Advisor** card. Inspect its suggested configuration change and estimated token/cost telemetry. **Live AI** identifies a fresh model response, **Cached DB Hit** a confirmed database cache lookup, and **Reused diagnostic** a saved or shared result. Cache hits and reuse charge zero new model tokens; **Deterministic Fallback** remains available without Gemini credentials.

---

## 📊 Bonus Features at the Bottom

* **State Delta Tracker:** Compares consecutive successful runs within the active workload, showing changes in modeled latency, coherence survival, and configuration. It retains the last six transitions in this tab.
* **Capture Benchmark Snapshot & Persistent History:** Name and save a run, compare up to 3 runs side-by-side, or export **CSV / JSON**. **Restore to Simulator** loads a saved run from the active browser session into the controls; click **Run simulation** to execute it. Reloading retains the session's history access, while a fresh tab session has its own history; this is not a teammate-sharing interface.
* **Quick Filter Pills:** **All Runs**, **Nominal Only**, and **Pinned Only** include matching counts for the active workload's loaded runs. Filters run in memory without new API calls or database queries. Nominal means a `NOMINAL` coherence budget; pinned includes pinned or named snapshots. The table starts with the latest five matches; **Show all** expands the loaded matches.
* **Retention:** The database keeps at most 20 unpinned, unnamed runs per session across workloads. Named or pinned snapshots are protected. Unprotected runs older than 48 hours are eligible for cleanup when maintenance runs; see [README.md](README.md) for the commands and scheduling details.
