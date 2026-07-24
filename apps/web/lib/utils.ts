import { EventKind } from "@nightjar/shared";

/*
 * The database enforces kind/status/plan with CHECK constraints, but the
 * generated types surface them as plain strings — narrow at the boundary.
 */
export type NodeStatus = "unclaimed" | "online" | "offline";

export function toNodeStatus(status: string): NodeStatus {
  return status === "online" || status === "unclaimed" ? status : "offline";
}

export function toEventKind(kind: string): EventKind {
  const parsed = EventKind.safeParse(kind);
  return parsed.success ? parsed.data : "motion";
}

export function toPlan(plan: string): "free" | "plus" | "pro" {
  return plan === "plus" || plan === "pro" ? plan : "free";
}

/** A node is online when it says so *and* has phoned home in the last 2 minutes. */
export const NODE_STALE_MS = 2 * 60 * 1000;

export function isNodeOnline(
  status: NodeStatus,
  lastSeenAt: string | null,
  now: number = Date.now(),
): boolean {
  if (status !== "online" || !lastSeenAt) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && now - seen <= NODE_STALE_MS;
}

/** "just now", "4m ago", "3h ago", "2d ago", else a short date. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diffSec = Math.max(0, Math.floor((now - then) / 1000));
  if (diffSec < 45) return "just now";
  if (diffSec < 90) return "1m ago";
  const min = Math.round(diffSec / 60);
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: new Date(then).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}

export function formatDateTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  return new Date(then).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`;
}
