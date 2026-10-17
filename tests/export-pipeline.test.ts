import { createServer } from "node:http";
import { trace } from "@opentelemetry/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";

const BASIC = "dXNlcjpjYW5hcnk=";
const SECRET = ["sk", "synthetic", "canary", "0123456789"].join("-");
const DENIED = "private-file-canary-content";

afterEach(() => {
  trace.disable();
  vi.unstubAllEnvs();
});

async function exercise(profile: string, instance: string, carrier = "", enabled = true, orphan = false) {
  const bodies: string[] = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    bodies.push(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  vi.stubEnv("PI_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", `http://127.0.0.1:${address.port}/v1/traces`);
  vi.stubEnv("PI_OTEL_EXPORTER_OTLP_HEADERS", "");
  vi.stubEnv("PI_OTEL_RESOURCE_ATTRIBUTES", "");
  vi.stubEnv("PI_OTEL_METRICS_EXPORTER", "none");
  vi.stubEnv("PI_OTEL_PRIVACY_PROFILE", profile);
  vi.stubEnv("PI_OTEL_INSTANCE_ID", instance);
  vi.stubEnv("PI_OTEL_ENABLE", enabled ? "1" : "0");
  vi.stubEnv("PI_OTEL_TRACES_EXPORTER", "otlp");
  vi.stubEnv("TRACEPARENT", carrier);
  const handlers = new Map<string, Function>();
  const entries: { customType: string; data: any }[] = [];
  const pi = {
    on: (name: string, handler: Function) => handlers.set(name, handler),
    registerCommand: () => {},
    appendEntry: (customType: string, data: unknown) => entries.push({ customType, data }),
  };
  const ctx = { hasUI: false, model: { provider: "synthetic", id: "test-model" },
    sessionManager: { getSessionId: () => "copied-session-id", getSessionFile: () => "/test/session.jsonl" } };
  const emit = async (name: string, event = {}) => handlers.get(name)?.(event, ctx);
  try {
    extension(pi as any);
    await emit("session_start");
    await emit("input", { text: `test prompt Authorization: Basic ${BASIC}\n${SECRET}`, source: "interactive" });
    await emit("agent_start");
    await emit("turn_start", { turnIndex: 0, timestamp: Date.now() });
    await emit("tool_call", { toolCallId: "c-1", toolName: "bash", input: { command: "printf safe" } });
    await emit("tool_result", { toolCallId: "c-1", toolName: "bash", isError: false,
      content: [{ type: "text", text: `safe output\nAuthorization: Basic ${BASIC}\n${SECRET}` }] });
    await emit("tool_call", { toolCallId: "c-2", toolName: "read", input: { path: "/test/.env" } });
    if (orphan) await emit("agent_end", { messages: [] });
    await emit("tool_result", { toolCallId: "c-2", toolName: "read", isError: false,
      content: [{ type: "text", text: DENIED }] });
    const message = { role: "assistant", provider: "synthetic", model: "actual-model", stopReason: "stop",
      content: [{ type: "text", text: `finished safely ${SECRET}` }],
      usage: { input: 10, output: 5, cacheRead: 7, cacheWrite: 3, totalTokens: 25, cost: { total: 0.25 } } };
    await emit("turn_end", { turnIndex: 0, message, toolResults: [] });
    await emit("agent_end", { messages: [message] });
    await emit("session_shutdown");
    const wire = bodies.join("\n");
    const spans = bodies.flatMap((body) => JSON.parse(body).resourceSpans.flatMap((r: any) =>
      r.scopeSpans.flatMap((s: any) => s.spans)));
    return { wire, spans, entries };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function attributes(span: any) {
  return Object.fromEntries(span.attributes.map((a: any) => [a.key, Object.values(a.value)[0]]));
}

describe("real extension to OTLP HTTP", () => {
  // [itest->req~pi-telemetry.generation~1]
  it("redacts nested free text and prompt names, and suppresses denied read results", async () => {
    const { wire, spans, entries } = await exercise("detailed-with-redaction", "mac-a");
    for (const secret of [BASIC, SECRET, DENIED]) expect(wire).not.toContain(secret);
    expect(wire).toContain("safe output");
    const generation = spans.find((span: any) => attributes(span)["langfuse.observation.type"] === "generation");
    expect(generation).toBeDefined();
    expect(spans.find((span: any) => attributes(span)["pi.tool.call_id"] === "c-1").parentSpanId).toBe(generation.spanId);
    const attrs = attributes(generation);
    expect(attrs["langfuse.observation.model.name"]).toBe("actual-model");
    expect(JSON.parse(attrs["langfuse.observation.usage_details"] as string)).toEqual({
      input: 10, output: 5, cache_read_input_tokens: 7, cache_creation_input_tokens: 3, total: 25,
    });
    expect(attrs["pi.cost.estimated_usd"]).toBe(0.25);
    expect(attrs["langfuse.observation.cost_details"]).toBeUndefined();
    expect(attrs["langfuse.observation.output"]).toContain("finished safely");
    expect(entries).toHaveLength(2);
    expect(entries[1]).toEqual({ customType: "pi.telemetry.end", data: {
      run_id: entries[0].data.run_id, reason: "session_shutdown",
    } });
    expect(entries[0].customType).toBe("pi.telemetry");
    expect(entries[0].data.trace_id).toBe(generation.traceId);
    expect(entries[0].data.instance_id).toBe("mac-a");
  });

  it("omits unmatched late results whose original path can no longer be established", async () => {
    const { wire } = await exercise("detailed-with-redaction", "mac-a", "", true, true);
    expect(wire).not.toContain(DENIED);
    expect(wire).toContain("pi.tool.output.omitted");
  });

  it("strict mode omits prompt and response text everywhere, including span names", async () => {
    const { wire } = await exercise("strict", "mac-a");
    for (const text of [BASIC, SECRET, DENIED, "test prompt", "safe output", "finished safely"]) {
      expect(wire).not.toContain(text);
    }
  });

  it("persists a disabled boundary locally so resumed work cannot join an older live trace", async () => {
    const { wire, entries } = await exercise("strict", "mac-a", "", false);
    expect(wire).toBe("");
    expect(entries).toHaveLength(1);
    expect(entries[0].data).toMatchObject({ trace_id: null, exporter: "none", sampled: false });
  });

  // [itest->req~pi-telemetry.parent~1]
  it("joins Firstmate's carrier and respects an unsampled task", async () => {
    const carrier = `00-${"a".repeat(32)}-${"b".repeat(16)}`;
    const sampled = await exercise("strict", "mac-a", `${carrier}-01`);
    expect(sampled.entries[0].data.trace_id).toBe("a".repeat(32));
    expect(sampled.entries[0].data.sampled).toBe(true);
    trace.disable();
    const unsampled = await exercise("strict", "mac-a", `${carrier}-00`);
    expect(unsampled.entries[0].data.sampled).toBe(false);
    expect(unsampled.spans).toEqual([]);
    trace.disable();
    const invalid = await exercise("strict", "mac-a", `00-${"0".repeat(32)}-${"b".repeat(16)}-01`);
    expect(invalid.entries[0].data.trace_id).not.toBe("0".repeat(32));
  });

  // [itest->req~pi-telemetry.identity~1]
  it("a cloned session on another machine gets independent run and trace identities", async () => {
    const first = await exercise("strict", "mac-a");
    trace.disable();
    const second = await exercise("strict", "mac-b");
    expect(first.entries[0].data.session_id).toBe(second.entries[0].data.session_id);
    expect(first.entries[0].data.run_id).not.toBe(second.entries[0].data.run_id);
    expect(first.entries[0].data.trace_id).not.toBe(second.entries[0].data.trace_id);
  });
});
