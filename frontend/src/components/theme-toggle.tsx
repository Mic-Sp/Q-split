"use client";

import { useEffect, useState } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const dark = mounted && resolvedTheme === "dark";
  const label = mounted ? `Switch to ${dark ? "light" : "dark"} mode` : "Change color theme";

  return (
    <div role="group" aria-label="Color theme" className="flex shrink-0 items-center rounded-lg border border-slate-300 bg-white p-0.5 shadow-sm dark:border-slate-700 dark:bg-slate-900">
      <button type="button" disabled={!mounted} aria-label={label} title={label}
        onClick={() => setTheme(dark ? "light" : "dark")}
        className="grid size-8 place-items-center rounded-md text-slate-700 transition-colors hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50 dark:text-slate-200 dark:hover:bg-slate-800 dark:active:bg-slate-700">
        {dark ? <Sun size={16} aria-hidden="true" /> : <Moon size={16} aria-hidden="true" />}
      </button>
      <button type="button" disabled={!mounted} aria-label="Use system theme" title="Use system theme" aria-pressed={mounted && theme === "system"}
        onClick={() => setTheme("system")}
        className="grid size-8 place-items-center rounded-md text-slate-600 transition-colors hover:bg-slate-100 aria-pressed:bg-cyan-50 aria-pressed:text-cyan-800 dark:text-slate-400 dark:hover:bg-slate-800 dark:aria-pressed:bg-cyan-400/10 dark:aria-pressed:text-cyan-200">
        <Monitor size={15} aria-hidden="true" />
      </button>
    </div>
  );
}
