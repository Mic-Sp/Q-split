"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CompletedRun, HistoryAvailability, HistoryResult, SavedSimulationRun, SaveRunResult } from "@/types/run-history";
import { mergeRuns } from "@/lib/run-history";
import { snapshotPatch } from "@/lib/benchmark-snapshot";

export function usePersistentRuns() {
  const [runs, setRuns] = useState<SavedSimulationRun[]>([]);
  const [availability, setAvailability] = useState<HistoryAvailability | "loading">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(true);
  const [pendingCount, setPendingCount] = useState(0);
  const [savingCount, setSavingCount] = useState(0);
  const pending = useRef(new Map<string, CompletedRun>());
  const inFlight = useRef(new Map<string, Promise<SavedSimulationRun | null>>());
  const deleted = useRef(new Set<string>());
  const deleting = useRef(new Set<string>());
  const mutations = useRef(new Set<string>());
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [mutationMessage, setMutationMessage] = useState<string | null>(null);
  const mounted = useRef(false);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/runs?limit=20", { cache: "no-store", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000) });
      const result = await response.json() as HistoryResult;
      if (!mounted.current || signal?.aborted) return;
      if (result.status === "ready" && response.ok && Array.isArray(result.runs)) {
        setRuns((current) => mergeRuns(current, [...result.runs, ...(result.snapshots ?? [])]).filter(run => !deleted.current.has(run.id)));
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

  const persist = useCallback(function persistRun(run: CompletedRun): Promise<SavedSimulationRun | null> {
    if (deleted.current.has(run.id) || deleting.current.has(run.id)) return Promise.resolve(null);
    const active = inFlight.current.get(run.id);
    if (active) return active;
    const work = (async () => { try {
      const response = await fetch("/api/runs", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(run), signal: AbortSignal.timeout(8_000),
      });
      const result = await response.json() as SaveRunResult;
      if (result.status === "saved" && response.ok && result.run?.id === run.id) {
        if (pending.current.get(run.id) === run) pending.current.delete(run.id);
        if (mounted.current) {
          setRuns((current) => mergeRuns(current, [result.run]).filter(row => !deleted.current.has(row.id)));
          setPendingCount(pending.current.size); setAvailability("ready"); setMessage(null);
        }
        return result.run;
      } else if (result.status === "unconfigured" || result.status === "unavailable") {
        if (mounted.current) { setAvailability(result.status); setMessage(result.message); }
      } else throw new Error("History save rejected");
    } catch {
      if (mounted.current) {
        setAvailability("unavailable");
        setMessage("This run could not be saved. Your simulation result is available below; retry saving when history is reachable.");
      }
    }
    return null;
    })();
    inFlight.current.set(run.id, work);
    if (mounted.current) setSavingCount(inFlight.current.size);
    void work.then(() => {
      inFlight.current.delete(run.id);
      if (mounted.current) setSavingCount(inFlight.current.size);
      const newer = pending.current.get(run.id);
      if (newer && newer !== run && !deleting.current.has(run.id)) void persistRun(newer);
    });
    return work;
  }, []);

  const saveRun = useCallback((run: CompletedRun) => {
    if (deleted.current.has(run.id)) return;
    pending.current.set(run.id, run);
    if (mounted.current) setPendingCount(pending.current.size);
    // Saving is deliberately independent from the simulation's loading state.
    void persist(run);
  }, [persist]);

  const beginMutation = (id: string) => {
    if (mutations.current.has(id) || deleted.current.has(id)) return false;
    mutations.current.add(id); setBusyIds([...mutations.current]); setMutationMessage(null);
    return true;
  };
  const endMutation = (id: string) => {
    mutations.current.delete(id);
    if (mounted.current) setBusyIds([...mutations.current]);
  };

  const nameSnapshot = async (id: string, name: string, run?: CompletedRun): Promise<boolean> => {
    let metadata: ReturnType<typeof snapshotPatch>;
    try { metadata = snapshotPatch({ snapshotName: name }); }
    catch (error) { setMutationMessage(error instanceof Error ? error.message : "Provide a valid snapshot name."); return false; }
    if (!beginMutation(id)) return false;
    try {
      // Capturing can race the original background save. Ensure the immutable
      // completed run exists before PATCH, retaining any queued advisor output.
      if (run) {
        const candidate = pending.current.get(id) ?? run;
        pending.current.set(id, candidate); setPendingCount(pending.current.size);
        if (!await persist(candidate)) throw new Error("The completed run has not reached the database. Keep the label and retry capture when history is available.");
      } else if (inFlight.current.has(id)) await inFlight.current.get(id);
      const response = await fetch(`/api/runs/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(metadata), signal: AbortSignal.timeout(8_000) });
      const result = await response.json();
      if (!response.ok || result.status !== "saved" || result.run?.id !== id) throw new Error(result.message || "Snapshot naming failed. Keep the label and retry.");
      if (mounted.current) setRuns(current => mergeRuns(current, [result.run]).filter(row => !deleted.current.has(row.id)));
      return true;
    } catch (error) {
      if (mounted.current) setMutationMessage(error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" ? error.message : "Snapshot could not be saved. Your run and label are still available; retry when connected.");
      return false;
    } finally { endMutation(id); }
  };

  const deleteRun = async (id: string): Promise<boolean> => {
    if (!beginMutation(id)) return false;
    deleting.current.add(id);
    try {
      // Finish an outstanding POST first. Queued/late advisor saves stay paused
      // and cannot recreate an intentionally deleted record in this tab.
      await inFlight.current.get(id);
      const response = await fetch(`/api/runs/${id}`, { method: "DELETE", signal: AbortSignal.timeout(8_000) });
      const result = await response.json();
      if (!response.ok || result.status !== "deleted" || result.id !== id) throw new Error(result.message || "Run deletion failed. The table entry has been retained.");
      deleted.current.add(id); pending.current.delete(id);
      if (mounted.current) { setRuns(current => current.filter(run => run.id !== id)); setPendingCount(pending.current.size); }
      return true;
    } catch (error) {
      if (mounted.current) setMutationMessage(error instanceof Error && error.name !== "TypeError" && error.name !== "TimeoutError" ? error.message : "Run could not be deleted. It remains in the table; retry when connected.");
      return false;
    } finally {
      deleting.current.delete(id); endMutation(id);
      const queued = pending.current.get(id);
      if (queued && !deleted.current.has(id)) void persist(queued);
    }
  };

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

  return { runs, availability, message: mutationMessage ?? message, refreshing, pendingCount, savingCount, busyIds,
    refresh: refreshHistory, retryPending, saveRun, nameSnapshot, deleteRun, isDeleted: (id: string) => deleted.current.has(id) };
}
