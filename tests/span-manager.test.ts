import { describe, expect, it } from "vitest";
import { createRedactor } from "../src/privacy/redactor.js";
import { createPayloadPolicy } from "../src/privacy/payload-policy.js";
import { createSpanManager } from "../src/trace/span-manager.js";

class FakeSpan {
  public ended = false;
  public name: string;
  public attributes: Record<string, unknown> = {};
  public events: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
  public status?: { code: number; message?: string };

  constructor(name: string, private readonly traceId: string, private readonly spanId: string) {
    this.name = name;
  }

  spanContext() {
    return { traceId: this.traceId, spanId: this.spanId, traceFlags: 1 };
  }

  setAttribute(key: string, value: unknown) {
    this.attributes[key] = value;
    return this;
  }

  setAttributes(attributes: Record<string, unknown>) {
    Object.assign(this.attributes, attributes);
    return this;
  }

  updateName(name: string) {
    this.name = name;
    return this;
  }

  addEvent(name: string, attrs?: Record<string, unknown>) {
    this.events.push({ name, attrs });
    return this;
  }

  setStatus(status: { code: number; message?: string }) {
    this.status = status;
    return this;
  }

  end() {
    this.ended = true;
  }
}

class FakeTracer {
  private count = 0;
  public spans: FakeSpan[] = [];

  startSpan(name: string) {
    this.count += 1;
    const span = new FakeSpan(name, "trace-123", `span-${this.count}`);
    this.spans.push(span);
    return span;
  }
}

describe("span manager", () => {
  it("creates lifecycle spans and tracks trace id", () => {
    const tracer = new FakeTracer();
    const policy = createPayloadPolicy({
      profile: "detailed-with-redaction",
      payloadMaxBytes: 1024,
      redactor: createRedactor({ extraSensitiveKeys: [], pathDenylist: [] }),
    });

    const manager = createSpanManager({
      tracer: tracer as never,
      payloadPolicy: policy,
    });

    manager.onSessionStart({ sessionId: "session-1", sessionFile: "session.jsonl" });
    manager.onAgentStart();
    manager.onTurnStart({ turnIndex: 0 });
    manager.onToolCall({
      toolCallId: "tool-1",
      toolName: "bash",
      input: { command: "echo hello" },
      turnIndex: 0,
    });
    manager.onToolResult({
      toolCallId: "tool-1",
      toolName: "bash",
      isError: false,
      output: { stdout: "hello" },
      turnIndex: 0,
    });
    manager.onTurnEnd({ turnIndex: 0, toolResults: 1, stopReason: "stop" });
    manager.onAgentEnd({ stopReason: "stop" });

    const traceId = manager.getTraceId();
    expect(traceId).toBe("trace-123");

    const toolSpan = tracer.spans.find((span) => span.name.includes("pi.tool: bash"));
    expect(toolSpan).toBeTruthy();
    expect(toolSpan?.ended).toBe(true);
  });

  it("marks tool span as error when tool_result is error", () => {
    const tracer = new FakeTracer();
    const policy = createPayloadPolicy({
      profile: "detailed-with-redaction",
      payloadMaxBytes: 1024,
      redactor: createRedactor({ extraSensitiveKeys: [], pathDenylist: [] }),
    });

    const manager = createSpanManager({ tracer: tracer as never, payloadPolicy: policy });

    manager.onSessionStart({ sessionId: "session-1" });
    manager.onTurnStart({ turnIndex: 1 });
    manager.onToolCall({ toolCallId: "tool-2", toolName: "read", input: { path: "a" }, turnIndex: 1 });
    manager.onToolResult({
      toolCallId: "tool-2",
      toolName: "read",
      isError: true,
      output: { error: "fail" },
      turnIndex: 1,
    });

    const toolSpan = tracer.spans.find((span) => span.name === "pi.tool: read");
    expect(toolSpan?.status).toEqual({ code: 2, message: "tool_result error" });
    expect(toolSpan?.ended).toBe(true);
  });

  it("closes orphan spans on shutdown", () => {
    const tracer = new FakeTracer();
    const policy = createPayloadPolicy({
      profile: "detailed-with-redaction",
      payloadMaxBytes: 1024,
      redactor: createRedactor({ extraSensitiveKeys: [], pathDenylist: [] }),
    });

    const manager = createSpanManager({ tracer: tracer as never, payloadPolicy: policy });

    manager.onSessionStart({ sessionId: "session-1" });
    manager.onAgentStart();
    manager.onTurnStart({ turnIndex: 1 });
    manager.onToolCall({ toolCallId: "tool-x", toolName: "bash", input: { command: "sleep 1" }, turnIndex: 1 });

    manager.shutdown();

    expect(tracer.spans.every((span) => span.ended)).toBe(true);
  });

  it("records file paths and redacted commands as tool span attributes", () => {
    const tracer = new FakeTracer();
    const redactor = createRedactor({ extraSensitiveKeys: [], pathDenylist: [] });
    const policy = createPayloadPolicy({ profile: "detailed-with-redaction", payloadMaxBytes: 1024, redactor });
    const manager = createSpanManager({ tracer: tracer as never, payloadPolicy: policy, redactText: redactor.redactText });

    manager.onSessionStart({ sessionId: "s", sessionFile: "s.jsonl" });
    manager.onAgentStart();
    manager.onTurnStart({ turnIndex: 0 });
    manager.onToolCall({ toolCallId: "r", toolName: "read", input: { path: "skills/code/SKILL.md" }, turnIndex: 0 });
    manager.onToolCall({
      toolCallId: "b",
      toolName: "bash",
      input: { command: "API_KEY=abc123 curl -H 'Authorization: Bearer tok.en' https://x && echo sk-abcdefghijk" },
      turnIndex: 0,
    });

    const read = tracer.spans.find((span) => span.name === "pi.tool: read");
    expect(read?.attributes["pi.tool.path"]).toBe("skills/code/SKILL.md");

    const bash = tracer.spans.find((span) => span.name.startsWith("pi.tool: bash"));
    const command = String(bash?.attributes["pi.tool.command"]);
    expect(command).toContain("curl");
    for (const secret of ["abc123", "tok.en", "sk-abcdefghijk"]) {
      expect(command).not.toContain(secret);
      expect(bash?.name).not.toContain(secret);
    }
  });

  it("keeps command text out of spans without a redactor or under the strict profile", () => {
    for (const options of [{}, { redactText: (text: string) => text, strict: true }]) {
      const tracer = new FakeTracer();
      const policy = createPayloadPolicy({
        profile: "strict",
        payloadMaxBytes: 1024,
        redactor: createRedactor({ extraSensitiveKeys: [], pathDenylist: [] }),
      });
      const manager = createSpanManager({ tracer: tracer as never, payloadPolicy: policy, ...options });
      manager.onSessionStart({ sessionId: "s", sessionFile: "s.jsonl" });
      manager.onAgentStart();
      manager.onTurnStart({ turnIndex: 0 });
      manager.onToolCall({ toolCallId: "b", toolName: "bash", input: { command: "echo secret-ish" }, turnIndex: 0 });
      const bash = tracer.spans.find((span) => span.name.startsWith("pi.tool: bash"));
      expect(bash?.name).toBe("pi.tool: bash");
      expect(bash?.attributes["pi.tool.command"]).toBeUndefined();
    }
  });
});
