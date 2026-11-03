import { ImageResponse } from "next/og";

export const alt = "Q-Split — Hybrid Quantum-Classical Workload Profiler. Compare CPU, GPU and QPU routing, latency and coherence across two workloads and five hardware profiles.";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/** Static social preview: rendered at build time with no external image/font requests. */
export default function OpenGraphImage() {
  return new ImageResponse(
    <div style={{
      width: "100%", height: "100%", display: "flex", flexDirection: "column",
      justifyContent: "space-between", padding: "46px 56px", color: "#e2e8f0",
      background: "linear-gradient(120deg, #020617 0%, #0f172a 65%, #083344 100%)",
      fontFamily: "sans-serif", borderTop: "8px solid #22d3ee",
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 19, letterSpacing: 3, color: "#67e8f9" }}>
        <span>THE QUANTUM OFFLOAD QUESTION</span>
        <span style={{ color: "#94a3b8", letterSpacing: 0 }}>Interactive simulator</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <div style={{ fontSize: 104, fontWeight: 700, letterSpacing: -5, color: "#f8fafc", lineHeight: 1.1 }}>Q-Split</div>
        <div style={{ fontSize: 34, marginTop: 8, color: "#67e8f9" }}>Hybrid Quantum-Classical Workload Profiler</div>
        <div style={{ fontSize: 24, marginTop: 18, color: "#cbd5e1" }}>Find the bottleneck. Compare the tradeoffs. Choose where to compute.</div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        {[
          { step: "01 / PREPARE", label: "CPU / GPU", accent: "#7dd3fc" },
          { step: "02 / QUANTUM KERNEL", label: "QPU", accent: "#c4b5fd" },
          { step: "03 / PROCESS RESULTS", label: "CPU / GPU", accent: "#67e8f9" },
        ].map(({ step, label, accent }, index) => (
          <div key={step} style={{ display: "flex", alignItems: "center", flex: 1, gap: 18 }}>
            {index > 0 && <span style={{ fontSize: 30, color: "#475569" }}>→</span>}
            <div style={{ display: "flex", flexDirection: "column", flex: 1, padding: "15px 20px", border: "1px solid #334155", borderRadius: 14, background: "#0f172a" }}>
              <span style={{ fontSize: 13, color: "#94a3b8", letterSpacing: 1 }}>{step}</span>
              <span style={{ fontSize: 28, color: accent, marginTop: 7, fontWeight: 700 }}>{label}</span>
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12 }}>
        {["2 workloads", "5 hardware profiles", "Latency + coherence"].map(badge => (
          <span key={badge} style={{ padding: "8px 16px", background: "#164e63", border: "1px solid #155e75", borderRadius: 24, fontSize: 19, color: "#cffafe" }}>{badge}</span>
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 18, color: "#94a3b8" }}>
        <span>Next.js · FastAPI · Qiskit Aer</span>
        <span style={{ color: "#67e8f9" }}>q-split.vercel.app</span>
      </div>
    </div>,
    size,
  );
}
