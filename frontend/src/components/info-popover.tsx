"use client";

import { useState, type ReactNode } from "react";
import { TierTooltip } from "@/components/tier-tooltip";

/**
 * Adapt the shared controlled tooltip into an info trigger without a selection action or tier footer.
 */
export function InfoPopover({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return <TierTooltip label={label} open={open} onOpenChange={setOpen} variant="info" footer={false}>{children}</TierTooltip>;
}
