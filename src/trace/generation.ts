import type { Span } from "@opentelemetry/api";
import type { PayloadPolicy } from "../privacy/payload-policy.js";

/** Only public assistant text, never hidden reasoning or binary content. */
export function assistantText(message: unknown): string | undefined {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content.filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text).join("\n");
}

export function payloadAttribute(span: Span, policy: PayloadPolicy, name: string, value: unknown, path?: string) {
  const payload = policy.sanitize(value, { path });
  span.setAttributes(policy.toAttributes(`pi.${name}`, payload));
  if (payload.text !== undefined) span.setAttribute(`langfuse.observation.${name}`, payload.text);
  return payload;
}

function nonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Langfuse's native OTLP generation mapping. Pi prices are estimates, not billing receipts. */
// [impl->req~pi-telemetry.generation~1]
export function generationAttributes(span: Span, message: unknown, policy: PayloadPolicy): void {
  if (!message || typeof message !== "object") return;
  const source = message as Record<string, any>;
  span.setAttribute("langfuse.observation.type", "generation");
  const model = source.responseModel ?? source.model;
  if (typeof model === "string") span.setAttribute("langfuse.observation.model.name", model);
  if (typeof source.provider === "string") span.setAttribute("gen_ai.system", source.provider);
  const text = assistantText(message);
  if (text !== undefined) payloadAttribute(span, policy, "output", text);
  usageAttributes(span, source.usage ?? {});
}

function usageAttributes(span: Span, usage: Record<string, any>): void {
  const details = Object.fromEntries(Object.entries({
    input: usage.input, output: usage.output, cache_read_input_tokens: usage.cacheRead,
    cache_creation_input_tokens: usage.cacheWrite, total: usage.totalTokens,
  }).filter(([, value]) => nonnegative(value)));
  span.setAttribute("pi.usage.status", Object.keys(details).length === 5 ? "complete" :
    Object.keys(details).length ? "partial" : "unknown");
  if (Object.keys(details).length) span.setAttribute("langfuse.observation.usage_details", JSON.stringify(details));
  if (nonnegative(usage.cost?.total)) span.setAttribute("pi.cost.estimated_usd", usage.cost.total);
  span.setAttribute("pi.cost.basis", "provider-price-estimate-not-billed");
}
