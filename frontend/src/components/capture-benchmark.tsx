"use client";

import { useState } from "react";
import { Camera, LoaderCircle } from "lucide-react";
import { SNAPSHOT_NAME_LIMIT } from "@/lib/benchmark-snapshot";
import type { CompletedRun } from "@/types/run-history";
import type { Snapshot } from "@/lib/telemetry";

/**
 * Name the current completed snapshot, clearing the input only after the async save/pin operation succeeds.
 */
export function CaptureBenchmark({ snapshot, disabled, busy, onCapture }: {
  snapshot: Snapshot | null;
  disabled: boolean;
  busy: boolean;
  onCapture: (id: string, name: string, run: CompletedRun) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [saved, setSaved] = useState(false);
  return <form aria-label="Capture Benchmark Snapshot" className="flex flex-wrap items-center gap-2" onSubmit={async event => {
    event.preventDefault();
    if (!snapshot || disabled || busy || !name.trim()) return;
    setSaved(false);
    if (await onCapture(snapshot.id, name, { id: snapshot.id, completedAt: snapshot.completedAt, request: snapshot.request, telemetry: snapshot.data })) { setSaved(true); setName(""); }
  }}>
    <input aria-label="Benchmark snapshot name" value={name} maxLength={SNAPSHOT_NAME_LIMIT} onChange={event => { setName(event.target.value); setSaved(false); }} disabled={!snapshot || disabled || busy}
      placeholder="Name this completed run…" className="min-h-8 w-44 max-w-full rounded-md border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200 disabled:opacity-50" />
    <button type="submit" disabled={!snapshot || disabled || busy || !name.trim()} className="inline-flex min-h-8 items-center gap-1.5 rounded-md border border-cyan-400/25 px-2 py-1 text-[10px] font-semibold text-cyan-200 hover:bg-cyan-400/10 disabled:opacity-40">
      {busy ? <LoaderCircle size={12} className="animate-spin" /> : <Camera size={12} />}Capture Benchmark Snapshot
    </button>
    {saved && <span role="status" className="text-[10px] text-emerald-300">Benchmark Snapshot saved.</span>}
  </form>;
}
