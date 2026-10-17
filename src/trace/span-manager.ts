import { ROOT_CONTEXT, SpanStatusCode, trace, type Span, type Tracer, type Context } from "@opentelemetry/api";
import type { PayloadPolicy } from "../privacy/payload-policy.js";
import { assistantText, generationAttributes, payloadAttribute } from "./generation.js";

interface SessionStartArgs {
  sessionId: string;
  sessionFile?: string;
}

interface TurnStartArgs {
  turnIndex: number;
  timestamp?: number;
}

interface TurnEndArgs {
  turnIndex: number;
  toolResults: number;
  stopReason?: string;
  message?: unknown;
}

interface ToolCallArgs {
  toolCallId: string;
  toolName: string;
  input: unknown;
  turnIndex?: number;
}

interface ToolResultArgs {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  output: unknown;
  turnIndex?: number;
}

interface SpanManagerOptions {
  tracer: Tracer;
  payloadPolicy: PayloadPolicy;
  /** Masks secrets in command text placed in span names and attributes; commands are omitted without it. */
  redactText?: (text: string) => string;
  /** The strict profile keeps command text out of spans entirely. */
  strict?: boolean;
  now?: () => number;
  parentContext?: Context;
  attributes?: Record<string, string>;
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function previewText(value: string, maxChars: number): string {
  const normalized = normalizeText(value);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}…`;
}

function stringField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function buildToolSpanName(toolName: string, command: string | undefined): string {
  return command ? `pi.tool: ${toolName}(${previewText(command, 120)})` : `pi.tool: ${toolName}`;
}

const COMMAND_ATTRIBUTE_MAX_CHARS = 2000;

export function createSpanManager(options: SpanManagerOptions) {
  const now = options.now ?? Date.now;

  let sessionSpan: Span | undefined;
  let agentSpan: Span | undefined;
  const turns = new Map<number, Span>();
  const tools = new Map<string, Span>();
  const toolPaths = new Map<string, string | undefined>();
  let traceId: string | undefined;
  let input: string | undefined;
  let activeTurnIndex: number | undefined;

  const attachInput = (span: Span) => {
    if (input === undefined) return;
    payloadAttribute(span, options.payloadPolicy, "input", input);
    span.setAttribute("pi.input.basis", "last-observed-input-not-full-request-context");
  };
  const childContext = (span: Span) => trace.setSpan(ROOT_CONTEXT, span);
  const startSpan = (name: string, startTime: number, parent = options.parentContext ?? ROOT_CONTEXT) =>
    options.tracer.startSpan(name, { startTime, attributes: options.attributes }, parent);

  const safeEnd = (span: Span | undefined): void => {
    if (!span) return;
    span.end(now());
  };

  const closeToolSpans = (reason: string): void => {
    for (const [toolCallId, span] of tools.entries()) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `orphan tool span (${reason})` });
      span.setAttribute("pi.tool.orphan", true);
      safeEnd(span);
      tools.delete(toolCallId);
      toolPaths.delete(toolCallId);
    }
  };

  const closeTurnSpans = (reason: string): void => {
    for (const [turnIndex, span] of turns.entries()) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: `orphan turn span (${reason})` });
      span.setAttribute("pi.turn.orphan", true);
      safeEnd(span);
      turns.delete(turnIndex);
    }
  };

  const closeAgentSpan = (reason: string): void => {
    if (!agentSpan) return;
    agentSpan.setStatus({ code: SpanStatusCode.ERROR, message: `orphan agent span (${reason})` });
    agentSpan.setAttribute("pi.agent.orphan", true);
    safeEnd(agentSpan);
    agentSpan = undefined;
  };

  const getToolParent = (turnIndex: number | undefined): Span | undefined => {
    const index = turnIndex ?? activeTurnIndex;
    const turn = index === undefined ? undefined : turns.get(index);
    return turn ?? agentSpan ?? sessionSpan;
  };

  const setTraceId = (span: Span | undefined): void => {
    traceId = span?.spanContext().traceId;
  };

  return {
    getTraceId(): string | undefined {
      return traceId;
    },

    isSampled(): boolean {
      return Boolean((sessionSpan?.spanContext().traceFlags ?? 0) & 1);
    },

    onSessionStart(args: SessionStartArgs): void {
      if (sessionSpan) {
        closeToolSpans("session_restart");
        closeTurnSpans("session_restart");
        closeAgentSpan("session_restart");
        safeEnd(sessionSpan);
      }

      input = undefined;
      activeTurnIndex = undefined;
      sessionSpan = startSpan("pi.session", now());
      sessionSpan.setAttribute("pi.session.id", args.sessionId);
      sessionSpan.setAttribute("session.id", args.sessionId);
      if (args.sessionFile) {
        sessionSpan.setAttribute("pi.session.file", args.sessionFile);
      }
      setTraceId(sessionSpan);
    },

    onInput(args: { text: string; source: string; imageCount?: number; path?: string }): void {
      if (!sessionSpan) return;

      input = args.text;
      const sanitized = options.payloadPolicy.sanitize(args.text, { path: args.path });
      sessionSpan.addEvent("input", {
        "pi.event.type": "input",
        "pi.input.source": args.source,
        "pi.input.images": args.imageCount ?? 0,
        ...options.payloadPolicy.toAttributes("pi.input", sanitized),
      });

      const namePreview = !options.strict && options.redactText ? previewText(options.redactText(args.text), 50) : "";
      if (namePreview) {
        sessionSpan.updateName(`pi.session ${namePreview}`);
      }
    },

    onAgentStart(): void {
      if (!sessionSpan) return;
      agentSpan = startSpan("pi.agent", now(), childContext(sessionSpan));
      attachInput(agentSpan);
    },

    onAgentEnd(args: { stopReason?: string; message?: unknown }): void {
      if (agentSpan) {
        const output = assistantText(args.message);
        if (output !== undefined) payloadAttribute(agentSpan, options.payloadPolicy, "output", output);
        agentSpan.addEvent("agent_end", {
          "pi.event.type": "agent_end",
          "pi.message.stop_reason": args.stopReason ?? "",
        });
      }

      closeToolSpans("agent_end");
      closeTurnSpans("agent_end");
      safeEnd(agentSpan);
      agentSpan = undefined;
    },

    onTurnStart(args: TurnStartArgs): void {
      const parent = agentSpan ?? sessionSpan;
      if (!parent) return;

      const turnSpan = startSpan("pi.turn", args.timestamp ?? now(), childContext(parent));
      attachInput(turnSpan);
      turnSpan.setAttribute("pi.turn.index", args.turnIndex);
      turns.set(args.turnIndex, turnSpan);
      activeTurnIndex = args.turnIndex;
    },

    onTurnEnd(args: TurnEndArgs): void {
      const span = turns.get(args.turnIndex);
      if (!span) return;

      generationAttributes(span, args.message, options.payloadPolicy);
      span.addEvent("turn_end", {
        "pi.event.type": "turn_end",
        "pi.turn.index": args.turnIndex,
        "pi.turn.tool_results": args.toolResults,
        "pi.message.stop_reason": args.stopReason ?? "",
      });
      safeEnd(span);
      turns.delete(args.turnIndex);
      if (activeTurnIndex === args.turnIndex) activeTurnIndex = undefined;
    },

    onToolCall(args: ToolCallArgs): void {
      const parent = getToolParent(args.turnIndex);
      if (!parent) return;

      const parentCtx = childContext(parent);
      const rawCommand = args.toolName === "bash" ? stringField(args.input, "command") : undefined;
      // Never place a raw command in telemetry: it can carry credentials.
      const command = rawCommand && options.redactText && !options.strict ? options.redactText(rawCommand) : undefined;
      const span = startSpan(buildToolSpanName(args.toolName, command), now(), parentCtx);

      span.setAttribute("pi.tool.name", args.toolName);
      span.setAttribute("pi.tool.call_id", args.toolCallId);
      // Span attributes, unlike events, reach backends such as Langfuse as queryable metadata.
      const path = stringField(args.input, "path");
      if (path) {
        span.setAttribute("pi.tool.path", path);
      }
      if (command) {
        span.setAttribute("pi.tool.command", command.slice(0, COMMAND_ATTRIBUTE_MAX_CHARS));
      }
      if (args.turnIndex !== undefined) {
        span.setAttribute("pi.turn.index", args.turnIndex);
      }

      toolPaths.set(args.toolCallId, path);
      const sanitized = payloadAttribute(span, options.payloadPolicy, "input", args.input, path);
      span.addEvent("tool_call", {
        "pi.event.type": "tool_call",
        "pi.tool.name": args.toolName,
        "pi.tool.call_id": args.toolCallId,
        ...options.payloadPolicy.toAttributes("pi.tool.input", sanitized),
      });

      tools.set(args.toolCallId, span);
    },

    onToolResult(args: ToolResultArgs): void {
      const span = tools.get(args.toolCallId);
      const target = span ?? sessionSpan;
      if (!target) return;

      const path = toolPaths.get(args.toolCallId);
      // Without a matching call we cannot know whether the result came from a denied path.
      const sanitized = span ? payloadAttribute(target, options.payloadPolicy, "output", args.output, path) : undefined;
      target.addEvent("tool_result", {
        "pi.event.type": "tool_result",
        "pi.tool.name": args.toolName,
        "pi.tool.call_id": args.toolCallId,
        "pi.tool.is_error": args.isError,
        "pi.turn.index": args.turnIndex ?? -1,
        ...(sanitized ? options.payloadPolicy.toAttributes("pi.tool.output", sanitized) : { "pi.tool.output.omitted": true }),
      });

      if (span) {
        if (args.isError) {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "tool_result error" });
        }
        safeEnd(span);
        tools.delete(args.toolCallId);
        toolPaths.delete(args.toolCallId);
      }
    },

    onModelSelect(args: { provider: string; modelId: string; source: string }): void {
      if (!sessionSpan) return;
      sessionSpan.addEvent("model_select", {
        "pi.event.type": "model_select",
        "pi.model.provider": args.provider,
        "pi.model.id": args.modelId,
        "pi.model.source": args.source,
      });
    },

    onSessionCompact(args: { firstKeptEntryId?: string; tokensBefore?: number; summary?: unknown }): void {
      if (!sessionSpan) return;
      const sanitized = options.payloadPolicy.sanitize(args.summary);
      sessionSpan.addEvent("session_compact", {
        "pi.event.type": "session_compact",
        "pi.compaction.first_kept_entry": args.firstKeptEntryId ?? "",
        "pi.compaction.tokens_before": args.tokensBefore ?? 0,
        ...options.payloadPolicy.toAttributes("pi.compaction.summary", sanitized),
      });
    },

    onSessionTree(args: { oldLeafId?: string; newLeafId?: string; fromExtension?: boolean }): void {
      if (!sessionSpan) return;
      sessionSpan.addEvent("session_tree", {
        "pi.event.type": "session_tree",
        "pi.tree.old_leaf": args.oldLeafId ?? "",
        "pi.tree.new_leaf": args.newLeafId ?? "",
        "pi.tree.from_extension": args.fromExtension ?? false,
      });
    },

    shutdown(): void {
      closeToolSpans("shutdown");
      closeTurnSpans("shutdown");
      closeAgentSpan("shutdown");
      safeEnd(sessionSpan);
      sessionSpan = undefined;
      traceId = undefined;
    },
  };
}

export type SpanManager = ReturnType<typeof createSpanManager>;
