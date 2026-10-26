"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompletedRun, HistoryAvailability, HistoryResult, SavedSimulationRun, SaveRunResult } from "@/types/run-history";

function mergeRuns(current: SavedSimulationRun[], incoming: SavedSimulationRun[]) {
  const unique = new Map(current.map((run) => [run.id, run]));
  incoming.forEach((run) => unique.set(run.id, run));
  return [...unique.values()].sort((a, b) => b.completedAt.localeCompare(a.completedAt) || b.id.localeCompare(a.id)).slice(0, 20);
}

export function usePersistentRuns() {
  const [runs, setRuns] = useState<SavedSimulationRun[]>([]);
  const [availability, setAvailability] = useState<HistoryAvailability | "loading">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [savingCount, setSavingCount] = useState(0);
  const pending = useRef(new Map<string, CompletedRun>());
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/runs?limit=20", { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
      const result = await response.json() as HistoryResult;
      if (!mounted.current || signal?.aborted) return;
      if (result.status === "ready" && response.ok && Array.isArray(result.runs)) {
        setRuns((current) => mergeRuns(current, result.runs));
        setAvailability("ready"); setMessage(null);
      } else if (result.status === "unconfigured" || result.status === "unavailable") {
        setAvailability(result.status); setMessage(result.message);
      } else throw new Error("Invalid history response");
    } catch {
      if (!mounted.current || signal?.aborted) return;
      setAvailability("unavailable");
      setMessage("Persistent history could not be reached. Simulations still work normally; refresh history to retry.");
    } finally {
      if (mounted.current && !signal?.aborted) setRefreshing(false);
    }
  }, []);

  const refreshHistory = useCallback(() => {
    setRefreshing(true);
    return refresh();
  }, [refresh]);

  const persist = useCallback(async function persistRun(run: CompletedRun) {
    if (inFlight.current.has(run.id)) return;
    inFlight.current.add(run.id);
    if (mounted.current) setSavingCount(inFlight.current.size);
    try {
      const response = await fetch("/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(run), signal: AbortSignal.timeout(8_000),
      });
      const result = await response.json() as SaveRunResult;
      if (result.status === "saved" && response.ok && result.run?.id === run.id) {
        if (pending.current.get(run.id) === run) pending.current.delete(run.id);
        if (mounted.current) {
          setRuns((current) => mergeRuns(current, [result.run]));
          setPendingCount(pending.current.size); setAvailability("ready"); setMessage(null);
        }
      } else if (result.status === "unconfigured" || result.status === "unavailable") {
        if (mounted.current) { setAvailability(result.status); setMessage(result.message); }
      } else throw new Error("History save rejected");
    } catch {
      if (mounted.current) {
        setAvailability("unavailable");
        setMessage("This run could not be saved. Your simulation result is available below; retry saving when history is reachable.");
      }
    } finally {
      inFlight.current.delete(run.id);
      if (mounted.current) setSavingCount(inFlight.current.size);
      const newer = pending.current.get(run.id);
      if (newer && newer !== run) void persistRun(newer);
    }
  }, []);

  const saveRun = useCallback((run: CompletedRun) => {
    pending.current.set(run.id, run);
    if (mounted.current) setPendingCount(pending.current.size);
    // Saving is deliberately independent from the simulation's loading state.
    void persist(run);
  }, [persist]);

  const retryPending = useCallback(() => {
    void refreshHistory();
    pending.current.forEach((run) => { void persist(run); });
  }, [persist, refreshHistory]);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void Promise.resolve().then(() => {
      if (!controller.signal.aborted) return refresh(controller.signal);
    });
    return () => { mounted.current = false; controller.abort(); };
  }, [refresh]);

  return { runs, availability, message, refreshing, pendingCount, savingCount, refresh: refreshHistory, retryPending, saveRun };
}
