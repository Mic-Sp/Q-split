# 🧪 Q-Split — Quickstart Guide for Classmates
**Live App:** [https://q-split.vercel.app/](https://q-split.vercel.app/)

## What are you looking at?
**Q-Split** is a hybrid **CPU + GPU + Quantum (QPU)** simulator and profiler. 

Quantum computers aren't meant to replace your whole computer—they act like specialized co-processors (similar to a GPU) for specific math bottlenecks. Every workload in Q-Split is split into a **3-Stage Execution Pipeline**:
1. **Stage 01 (Classical Pre-processing):** Prepares and filters the data (`CPU` or `GPU`).
2. **Stage 02 (Quantum Kernel):** Runs the heavy quantum algorithm (`QPU`, or emulated in `CPU`/`GPU` RAM).
3. **Stage 03 (Classical Post-processing):** Verifies and formats the final answer (`CPU` or `GPU`).

Your goal is to find the best hardware combo (`CPU`, `GPU`, or `QPU`) without running out of memory, getting slowed down by data-transfer cables (PCIe/interconnect overhead), or losing your quantum state to hardware noise (**Decoherence**).

---

## 🕹️ How to Use the Controls (Top Panel)

1. **`01 / WORKLOAD PRESET` — Pick a Problem:**
   * **Shor's Cryptography:** Breaks encryption keys by factoring numbers (`N = 15` up to `RSA-2048`).
   * **Quantum-MIPS (LLM Vector Retrieval):** Searches an AI vector database (`M = 64` up to `1M` vectors) using Grover's search to find the best-matching LLM token in $\sqrt{M}$ steps.
2. **`02 / TARGET SCALE` — Pick the Problem Size:**
   * Hover over any button to see what it does! 
   * *Note:* The smallest scale (`N = 15` or `M = 64`) runs a **real live quantum circuit** in Python (`Qiskit Aer`). Larger scales use an analytical hardware profiler because simulating thousands of qubits would require more RAM than exists on Earth.
3. **`03 / HARDWARE PROFILE` — Pick a Quantum Computer:**
   * **IBM Heron NISQ (133 qubits):** Fast superconducting gates, sparse Heavy-Hex layout.
   * **Google Weber 2D (72 qubits):** Super-fast 2D grid superconducting chip.
   * **IonQ Forte Ion (36 qubits):** Trapped-ion laser quantum computer—super accurate (almost no noise) and zero routing overhead, but *much* slower gate speeds.
   * **Ideal Noise-Free:** Theoretical perfect quantum computer (100% coherence) for baseline comparisons.
4. **`04 / AVAILABLE QPU QUBITS` & `TIERS` — Trade Space for Speed:**
   * Give the QPU more qubits to unlock faster **Parallel Tiers** (`Sequential` $\rightarrow$ `Windowed` $\rightarrow$ `Carry-Lookahead / Multi-Oracle`). More qubits = shallower circuit = less time for noise to ruin the calculation!

---

## 🔥 3 Cool Experiments to Try Right Now

### Experiment 1: Watch a GPU Actually Slow Things Down (PCIe Overhead)
1. Keep **Shor's Cryptography** at **`N = 15`** on **IBM Heron NISQ**.
2. Scroll slightly to the **Execution pipeline** cards (`STAGE 01`, `STAGE 02`, `STAGE 03`).
3. Switch **Stage 01** from `CPU` to `GPU` and click **Run simulation**.
4. **What happens:** Stage 01 turns yellow (`WARNING`)! Factoring $N=15$ is tiny scalar math, so paying a `0.30 ms` penalty just to send data across the PCIe bus to the GPU is slower than keeping it on the CPU.

### Experiment 2: Where GPUs + QPUs Shine Together (Quantum-MIPS AI Search)
1. Change `01 / WORKLOAD PRESET` to **Quantum-MIPS** and select **`M = 128k (LLM Vocab)`**.
2. Set the pipeline route to **`GPU` $\rightarrow$ `QPU` $\rightarrow$ `GPU`** and click **Run simulation**.
3. **What happens:** Here, Stage 01 and Stage 03 are doing massive AI vector matrix math, so the `GPU` crushes the `CPU` and turns green (`OPTIMAL`).
4. Now switch `03 / HARDWARE PROFILE` between **IBM Heron** and **IonQ Forte** (make sure to bump QPU Qubits in `04` to `133` so the circuit fits) and run again to see the trade-off between superconducting speed vs. trapped-ion accuracy!

### Experiment 3: Break Classical RAM, Then Ask the AI Advisor
1. Select **Shor's Cryptography** $\rightarrow$ **`RSA-512`**.
2. In **Stage 02**, switch `RUN ON` from `QPU` to **`CPU`** or **`GPU`** and click **Run simulation**.
3. **What happens:** The pipeline hits a **Critical Bottleneck**—simulating 1,027 qubits classically requires $2^{1027}$ bytes of RAM (exceeding the 16 GiB limit).
4. Click **Generate analysis** inside the **AI Telemetry Advisor** card at the bottom left. Watch it diagnose the bottleneck, suggest the exact next button to click, and display live token/cost telemetry (click it a second time on the same run to see a `$0.00` **Neon DB Cache Hit**!).

---

## 📊 Bonus Features at the Bottom
* **State Delta Tracker:** Automatically diffs your current run against your previous run so you can see exactly how latency and fidelity changed.
* **Capture Benchmark Snapshot & Persistent History:** Name and save a run to the PostgreSQL database, check up to 3 runs to compare them side-by-side, click **Restore to Simulator** to load a teammate's settings, or export the table to **CSV / JSON**.