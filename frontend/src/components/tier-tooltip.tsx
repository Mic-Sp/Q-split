"use client";

import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleHelp } from "lucide-react";

/**
 * Share a controlled, portaled tooltip across tier, scale, and info triggers.
 * Hover/focus opens without selecting; click/Enter/Space may also call onSelect.
 * Position against the visual viewport, constrain overflow, support keyboard
 * scrolling/Escape, and delay closing so the pointer can enter the tooltip panel.
 * selected controls aria-pressed/styling independently from tooltip visibility.
 */
export function TierTooltip({ label, displayLabel, children, onSelect, open, onOpenChange, variant = "tier", footer = true, selected }: {
  label: string;
  displayLabel?: string;
  children: ReactNode;
  onSelect?: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  variant?: "tier" | "info" | "scale";
  footer?: boolean;
  selected?: boolean;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const hovering = useRef(false);
  const focused = useRef(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const show = () => { cancelClose(); onOpenChange(true); };
  const closeWhenIdle = () => {
    cancelClose();
    // Allow the pointer to cross the gap into the hoverable tooltip.
    closeTimer.current = setTimeout(() => {
      if (!hovering.current && !focused.current) onOpenChange(false);
    }, 150);
  };

  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!trigger.current || !panel.current) return;
      const anchor = trigger.current.getBoundingClientRect();
      const tooltip = panel.current;
      const margin = 12;
      const gap = 8;
      // A visual viewport can be smaller/offset during zoom or an on-screen keyboard; portals use viewport coordinates.
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0;
      const topEdge = viewport?.offsetTop ?? 0;
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      tooltip.style.maxWidth = `${Math.max(0, width - 2 * margin)}px`;
      tooltip.style.maxHeight = `${Math.max(0, height - 2 * margin)}px`;
      const bounds = tooltip.getBoundingClientRect();
      const below = topEdge + height - anchor.bottom - gap - margin;
      const above = anchor.top - topEdge - gap - margin;
      const placeBelow = below >= bounds.height || below >= above;
      const space = Math.max(0, placeBelow ? below : above);
      tooltip.style.maxHeight = `${Math.min(height - 2 * margin, space)}px`;
      const actualHeight = tooltip.getBoundingClientRect().height;
      const left = Math.max(leftEdge + margin, Math.min(anchor.left, leftEdge + width - bounds.width - margin));
      const top = Math.max(topEdge + margin, Math.min(
        placeBelow ? anchor.bottom + gap : anchor.top - actualHeight - gap,
        topEdge + height - actualHeight - margin,
      ));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${top}px`;
      tooltip.style.visibility = "visible";
    };
    const onScroll = (event: Event) => {
      // Scrolling the tooltip itself must not reset its constrained height or
      // scroll position. Ancestor/page scrolling still repositions the panel.
      if (event.target !== panel.current) position();
    };
    position();
    window.addEventListener("resize", position);
    window.addEventListener("scroll", onScroll, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    // Reflow after content/trigger resizing, and remove all observers/listeners when the panel closes.
    const observer = new ResizeObserver(position);
    if (trigger.current) observer.observe(trigger.current);
    if (panel.current) observer.observe(panel.current);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", onScroll, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [open, children]);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") { hovering.current = false; cancelClose(); onOpenChange(false); }
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !trigger.current?.contains(event.target) && !panel.current?.contains(event.target)) {
        hovering.current = false; cancelClose(); onOpenChange(false);
      }
    };
    document.addEventListener("keydown", dismiss);
    document.addEventListener("pointerdown", outside);
    return () => {
      document.removeEventListener("keydown", dismiss);
      document.removeEventListener("pointerdown", outside);
    };
  }, [open, onOpenChange]);

  return <>
    <button ref={trigger} type="button" aria-label={label} aria-pressed={selected} aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== "touch") { hovering.current = true; show(); } }}
      onPointerLeave={(event) => { if (event.pointerType !== "touch") { hovering.current = false; closeWhenIdle(); } }}
      onFocus={() => { focused.current = true; show(); }}
      onBlur={() => { focused.current = false; closeWhenIdle(); }}
      onKeyDown={(event) => {
        const tooltip = panel.current;
        if (!open || !tooltip || tooltip.scrollHeight <= tooltip.clientHeight) return;
        const distance: Record<string, number> = {
          ArrowDown: 48, ArrowUp: -48, PageDown: tooltip.clientHeight,
          PageUp: -tooltip.clientHeight, Home: -tooltip.scrollHeight, End: tooltip.scrollHeight,
        };
        if (event.key in distance) {
          event.preventDefault();
          tooltip.scrollBy({ top: distance[event.key] });
        }
      }}
      onClick={() => { show(); onSelect?.(); }}
      className={variant === "info" ? "inline-flex size-5 shrink-0 items-center justify-center rounded text-cyan-400/70 hover:bg-cyan-400/10 hover:text-cyan-200" : [
        variant === "scale" ? "min-h-9 rounded-lg border px-2 py-2 font-mono text-[11px] transition-colors" : "inline-flex min-h-8 items-center gap-1.5 rounded-md border px-2 py-1.5 text-left text-[10px]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-300",
        selected ? "border-cyan-400/50 bg-cyan-400/10 text-cyan-200" : "border-slate-800 text-slate-400 hover:border-cyan-400/40 hover:text-cyan-200",
        variant === "scale" && !selected ? "bg-slate-950/70" : "",
      ].join(" ")}>
      {variant !== "info" && (displayLabel ?? label)}{variant !== "scale" && <CircleHelp size={13} aria-hidden="true" className="shrink-0 text-cyan-400/70" />}
    </button>
    {open && createPortal(
      <div ref={panel} id={id} role="tooltip"
        onPointerEnter={() => { hovering.current = true; cancelClose(); }}
        onPointerLeave={() => { hovering.current = false; closeWhenIdle(); }}
        className="invisible fixed z-[100] w-96 overflow-y-auto rounded-xl border border-cyan-400/30 bg-slate-950 p-4 text-xs leading-6 text-slate-300 shadow-2xl shadow-black/60 [overflow-wrap:anywhere]">
        {children}
        {footer && <p className="mt-3 border-t border-slate-800 pt-2 text-[10px] leading-5 text-slate-500">Illustrative architecture model; physical error-correction overhead excluded. ↑ / ↓ scroll; Escape dismisses this tooltip.</p>}
      </div>, document.body,
    )}
  </>;
}
