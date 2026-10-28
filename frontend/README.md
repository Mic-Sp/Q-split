# ⚡ Q-Split
### Hybrid Quantum-Classical Workload Profiler & Heterogeneous Orchestrator

**Live Cockpit:** https://q-split.vercel.app/  
**Engine API (FastAPI):** https://q-split-engine.onrender.com/docs

---

## 🎯 Overview
**Q-Split** is a full-stack co-design observatory built to evaluate when quantum sub-routines outperform classical CPU/GPU baselines. By orchestrating a 3-stage execution pipeline across heterogeneous hardware, Q-Split tracks the exact tipping points where quantum advantage survives against PCIe bus transfer latency, circuit depth, and NISQ decoherence (T1/T2).

---

## 🛠️ System Architecture & Dual Engine
* Frontend & API: Next.js 15 (React 19, TypeScript, Tailwind CSS) with Zod validation and Prisma ORM backed by Neon Serverless PostgreSQL.
* Backend Engine: Containerized Python FastAPI executing real circuits via Qiskit Aer alongside an analytical hardware profiler.
* Dual Simulation Modes:
  1. Live Qiskit Aer Statevector Engine: Executes real 8-to-10 qubit quantum circuits for base scales (N=15 Shor's, M=64 Quantum-MIPS) with custom noise models and transpiler coupling maps.
  2. Analytical Co-Design Profiler: Closed-form systems modeling for intractable scales (N >= 21 through RSA-2048, M >= 1k through 1M vectors), tracking statevector RAM limits (16 * 2^n bytes), gate depth, and exponential coherence decay.

---

## 🎛️ Supported Workloads & Hardware Profiles

* Shor's Cryptography (N = 15, 21, 35, RSA-512, RSA-2048): CPU wins Stages 01 & 03 (scalar math; GPU PCIe launch overhead slows it down). QPU must survive deep modular exponentiation.
* Quantum-MIPS (LLM Vector Retrieval) (M = 64, 1k, 32k, 128k, 1M): GPU wins Stages 01 & 03 at scale (M >= 1k) via tensor-core LSH hashing & FP16 reranking. Grover search achieves sqrt(M) scaling.

### Hardware Profiles
* IBM Heron NISQ: 133-qubit Heavy-Hex superconducting lattice (sparse connectivity, higher SWAP routing depth).
* Google Weber 2D: 72-qubit 2D Square Grid superconducting transmon (denser connectivity, ultra-fast 20ns gates).
* IonQ Forte Ion: 36-qubit All-to-All Trapped-Ion (zero routing SWAP overhead and long coherence, but slower acoustic gate speeds).
* Ideal Noise-Free: Theoretical noise-free reference (100% coherence).

---

## 🤖 AI Telemetry Advisor & Unit Economics
* Powered by Google Gemini AI with strict system instruction grounding and a Hardware Control Constraint Guardrail.
* Neon PostgreSQL Read-Through Caching: Repeat runs fetch instantly with 0 API tokens / $0.000000 cost.
* Live UI Telemetry Strip: Displays execution source (LIVE GEMINI vs. NEON CACHE HIT), token counts, estimated USD cost, and latency.

---

## 🚀 Quickstart & Local Development

1. Clone & Install Dependencies:
   git clone https://github.com/your-username/q-split.git
   cd q-split
   npm install
   cd backend && pip install -r requirements.txt

2. Configure Environment Variables (.env):
   DATABASE_URL="postgresql://..."
   DIRECT_URL="postgresql://..."
   GEMINI_API_KEY="..."

3. Run Services:
   - Backend: cd backend && uvicorn main:app --reload --port 8000
   - Frontend: npm run dev (opens on http://localhost:3000)

4. Run Test Suites:
   - Backend: pytest
   - Frontend: npm test (includes the 1,620-configuration integration matrix)