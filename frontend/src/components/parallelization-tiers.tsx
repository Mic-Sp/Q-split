"use client";

import { TierTooltip } from "@/components/tier-tooltip";
import type { WorkloadId } from "@/types/telemetry";
import { activeParallelizationTier, workloadScaleLabel } from "@/lib/workloads";
import { useState } from "react";
import { formatValue, qubitThresholds } from "@/lib/telemetry";

/**
 * Resolve workload-specific formulas and highlight the capacity's unlocked tier.
 * The controlled qubit value owns selection, while local state owns tooltip visibility;
 * choosing a tier emits its exact threshold and does not change the hardware profile.
 */
export function ParallelizationTiers({ scale, availableQubits, onSelect, compact = false, workload = "shors_crypto" }: { scale: number; availableQubits: number; workload?: WorkloadId; onSelect: (value: number) => void; compact?: boolean }) {
  const [openTier, setOpenTier] = useState<string | null>(null);
  const n = workload === "shors_crypto" && (scale === 512 || scale === 2048) ? scale : Math.ceil(Math.log2(scale));
  const thresholds = qubitThresholds(scale, workload);
  const activeTier = activeParallelizationTier(scale, availableQubits, workload);
  const tiers = workload === "quantum_mips" ? [
    { key: "minimum", label: "Sequential minimum", shortLabel: "Sequential", value: thresholds.minimum, formula: "k + 4 qubits", calculation: `${n} + 4 = ${thresholds.minimum} qubits`, depth: "1.00× sequential Grover depth", tradeoff: "Serial inner-product oracle across O(√M) Grover iterations. At M = 64 this is a live 10-qubit marked-state Aer reference; it does not execute vector loading or adaptive maximum finding." },
    { key: "windowed", label: "Windowed Parallel", shortLabel: "Windowed", value: thresholds.windowed, formula: "2k + 8 qubits", calculation: `2 × ${n} + 8 = ${thresholds.windowed} qubits`, depth: "0.40× sequential Grover depth", tradeoff: "Parallel tree-based inner-product accumulation uses additional ancilla registers to reduce modeled circuit depth. Classical emulation must hold the entire allocated register in RAM." },
    { key: "ceiling", label: "Multi-Oracle ceiling", shortLabel: "Multi-Oracle", value: thresholds.ceiling, formula: "4k + 16 qubits", calculation: `4 × ${n} + 16 = ${thresholds.ceiling} qubits`, depth: "0.20× sequential Grover depth", tradeoff: "Partitioned parallel Grover amplitude amplification across multiple oracle registers. Extra qubits above this ceiling remain idle. O(√M) iterations still erode NISQ coherence at large scales; this is an analytical projection, not a physical speedup measurement." },
  ] : [
    {
      key: "minimum", label: "Sequential minimum", value: thresholds.minimum,
      shortLabel: "Sequential",
      formula: "2n + 3 qubits (8 qubits for N = 15)",
      calculation: scale === 15
        ? "N = 15 uses the fixed 8-qubit reference circuit instead of 2 × 4 + 3 = 11 qubits."
        : `2 × ${formatValue(n)} + 3 = ${formatValue(thresholds.minimum)} qubits`,
      depth: "O(n³) · sequential modular multiplication",
      tradeoff: "Minimizes qubit footprint with a Beauregard-style layout, at the cost of maximum gate depth, long execution times, and severe decoherence on NISQ hardware.",
    },
    {
      key: "windowed", label: "Windowed Parallel", value: thresholds.windowed,
      shortLabel: "Windowed",
      formula: "3n qubits",
      calculation: `3 × ${formatValue(n)} = ${formatValue(thresholds.windowed)} qubits`,
      depth: "O(n² log n) · windowed arithmetic",
      tradeoff: "Allocates extra workspace/ancilla qubits (Gidney/Ekerå-style) to precompute and batch modular exponentiation steps. Reduces modeled gate depth and execution latency by about 98% at RSA-512 compared with sequential mode; savings vary with scale.",
    },
    {
      key: "ceiling", label: "Carry-Lookahead ceiling", value: thresholds.ceiling,
      shortLabel: "Carry-Lookahead",
      formula: "5.5n qubits (rounded up to a whole qubit)",
      calculation: Number.isInteger(5.5 * n)
        ? `5.5 × ${formatValue(n)} = ${formatValue(thresholds.ceiling)} qubits`
        : `⌈5.5 × ${formatValue(n)}⌉ = ${formatValue(thresholds.ceiling)} qubits (${formatValue(5.5 * n)} rounded up)`,
      depth: "O(n log² n) · parallel carry-lookahead adders",
      tradeoff: "Trades a massive ancilla footprint (Van Meter/Itoh-style) to parallelize binary carry propagation down to the logarithmic depth floor. Any extra qubits beyond 5.5n remain idle and provide no further speedup.",
    },
  ];

  return <div role="group" aria-label="Parallelization thresholds" className={`${compact ? "" : "mt-2"} flex flex-wrap gap-1.5`}>
    {tiers.map((tier) => <TierTooltip key={tier.label} selected={activeTier === tier.key} label={`${tier.label} · ${formatValue(tier.value)} qubits`} onSelect={() => onSelect(tier.value)}
      displayLabel={compact ? `${tier.shortLabel} · ${formatValue(tier.value)}` : undefined}
      open={openTier === tier.label} onOpenChange={(isOpen) => setOpenTier((current) => isOpen ? tier.label : current === tier.label ? null : current)}>
      <p className="font-semibold text-cyan-200">{tier.label}</p>
      <p className="mt-1 text-[10px] text-slate-400">{workloadScaleLabel(scale, workload)} · {workload === "quantum_mips" ? "k" : "n"} = {formatValue(n)} bits</p>
      <dl className="mt-3 space-y-2">
        <div><dt className="text-[10px] uppercase tracking-wider text-slate-500">Qubit formula</dt><dd className="font-mono text-slate-200">{tier.formula}</dd></div>
        <div className="rounded-lg border border-cyan-400/15 bg-cyan-400/5 px-3 py-2"><dt className="text-[10px] text-slate-400">At the selected scale</dt><dd className="font-mono text-cyan-200">{tier.calculation}</dd></div>
        <div><dt className="text-[10px] uppercase tracking-wider text-slate-500">Circuit depth</dt><dd className="font-mono text-slate-200">{tier.depth}</dd></div>
      </dl>
      <p className="mt-3 text-slate-300">{tier.tradeoff}</p>
    </TierTooltip>)}
  </div>;
}
