import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { ROOT_CONTEXT, isSpanContextValid, trace, type Context } from "@opentelemetry/api";

/** Firstmate's explicit carrier convention. Invalid carriers begin an independent root. */
// [impl->req~pi-telemetry.parent~1]
export function parentContext(carrier: string | undefined): Context {
  const parts = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/.exec(carrier ?? "");
  if (!parts) return ROOT_CONTEXT;
  const span = { traceId: parts[1], spanId: parts[2], traceFlags: parseInt(parts[3], 16) & 1, isRemote: true };
  return isSpanContextValid(span) ? trace.setSpanContext(ROOT_CONTEXT, span) : ROOT_CONTEXT;
}

export function instanceId(): string {
  const label = process.env.PI_OTEL_INSTANCE_ID?.trim();
  if (label && /^[A-Za-z0-9._-]{1,128}$/.test(label)) return label;
  return createHash("sha256").update(label || hostname()).digest("hex").slice(0, 16);
}

export function runId(): string {
  return randomUUID();
}
