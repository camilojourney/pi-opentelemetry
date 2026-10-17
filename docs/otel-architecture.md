# OTel Architecture

## Scope

Kind: technical

Capability: `pi-telemetry`

Owns: the Pi extension's trace identity, generation mapping and telemetry event model.
Privacy policy is owned by [privacy-redaction.md](privacy-redaction.md).

This project provides the following observability coverage for the Pi Coding Agent.

1. **Trace**: Causal analysis and latency/root-cause visibility across session/turn/tool execution
2. **Metrics**: Usage, cost, and performance trend analysis
3. **Diagnostics**: Health checks for the active telemetry pipeline

## High-level Flow

Pi Extension Events  
→ Trace/Metrics Processor  
→ OTLP Export (HTTP)  
→ OpenTelemetry Collector  
→ Backend (Jaeger/Tempo + Prometheus/Grafana)

Recommendation: operate separate endpoints for traces and metrics.

- traces: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`
- metrics: `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT`
- fallback: `OTEL_EXPORTER_OTLP_ENDPOINT`

## Trace Model

Recommended span hierarchy:

- `pi.session`
  - `pi.agent`
    - `pi.turn`
      - `pi.tool:<tool-name>`

Recommended events:

- `input`
- `tool_call`
- `tool_result`
- `turn_end`
- `agent_end`
- `model_select`
- `session_compact`

Core principles:

- Create a tool span at `tool_call`, and close it at `tool_result`
- For orphan spans (missing end events), force-close at shutdown and mark as error
- Payload recording follows the privacy policy (see: [privacy-redaction.md](./privacy-redaction.md))

## Requirements

This section owns the native Pi and Langfuse exporter interface consumed by post-run collectors.

`req~pi-telemetry.identity~1`

WHEN a session starts or resumes, the exporter SHALL record a fresh run UUID,
instance label, session ID, trace ID, exporter mode and sampling decision in a
non-context `pi.telemetry` entry.

Needs: impl, itest

The entry uses schema `pi/telemetry-link/v1` and fields `run_id`, `instance_id`,
`session_id`, `trace_id`, `exporter`, `sampled`. Disabled telemetry still writes a
local boundary with `trace_id=null`, `exporter=none`, `sampled=false`; it sends
nothing and prevents a collector attaching resumed work to an older active trace.
A `pi.telemetry.end` entry records
`run_id` and `reason=session_shutdown`; shutdown is not task acceptance. In-memory
sessions have no durable JSONL, so consumers need their caller's public receipts.

`fleet.instance.id`, `fleet.run.id`, `pi.session.id` and Langfuse `session.id` are
span attributes. `PI_OTEL_INSTANCE_ID` optionally supplies a machine-local label;
the default is a truncated SHA-256 of the hostname. Unique run and span identities
do not depend on hostname uniqueness. Never copy running task metadata to start
independent work on another host.

`req~pi-telemetry.parent~1`

WHEN `TRACEPARENT` contains a valid W3C version-00 carrier, the exporter SHALL
parent the session to it and respect sampling. Invalid carriers SHALL begin an
independent trace.

Needs: impl, itest

This explicitly supports Firstmate's environment convention; OpenTelemetry does
not adopt that variable automatically. Resumes retain the task trace only when
the caller supplies the same carrier; every attempt still gets its own run UUID.

`req~pi-telemetry.generation~1`

WHEN a turn ends, the exporter SHALL expose its actual assistant model, known
usage and protected response through native Langfuse generation attributes.
Missing usage SHALL remain unknown, and Pi prices SHALL be labelled estimates.

Needs: impl, itest

The [native OTLP mapping](https://langfuse.com/integrations/native/opentelemetry)
uses `langfuse.observation.type=generation`, `.model.name`, `.input`, `.output` and
`.usage_details`. Usage keys are `input`, `output`, `cache_read_input_tokens`,
`cache_creation_input_tokens`, `total`. Pi's fresh input and cached input remain
separate. `pi.usage.status` is complete, partial or unknown. Only public text is
captured, not hidden reasoning or signatures. Tools are children of the active turn.

`pi.cost.estimated_usd` and `pi.cost.basis=provider-price-estimate-not-billed` carry
the reported estimate. No billed-cost attribute is emitted. Langfuse can separately
estimate model prices; neither estimate proves subscription charges. These turn
fields cover assistant calls, not auxiliary cache-warming, compaction or nested-tool
model usage. Metrics export is not required for these generation fields.

Generation input is the last observed user input, not the complete model request
or reconstructed context. `pi.input.basis=last-observed-input-not-full-request-context`
marks this limit; token counts remain the assistant's reported usage.
Input/output use the same bounded [privacy policy](privacy-redaction.md) as events.
Strict mode emits no body or prompt preview in any attribute or name. Denied read
paths also suppress the associated result body. Pattern redaction is not a general
PII detector; strict mode is the appropriate choice when bodies must not leave Pi.

## Metrics Model

### Counters

- `pi.session.count`
- `pi.turn.count`
- `pi.tool_call.count`
- `pi.tool_result.count`
- `pi.prompt.count`
- `pi.token.usage` (`type=input|output|cache_read|cache_write`)
- `pi.cost.usage` (`type=input|output|cache_read|cache_write`)

### Histograms

- `pi.session.duration` (s)
- `pi.turn.duration` (s)
- `pi.tool.duration` (s)

## Event → Telemetry Mapping

| Pi Event | Trace | Metrics |
|---|---|---|
| `session_start` | `pi.session` span start | `pi.session.count += 1` |
| `input` | session span event `input` | `pi.prompt.count += 1` |
| `agent_start` | `pi.agent` span start | - |
| `turn_start` | `pi.turn` span start | `pi.turn.count += 1` |
| `tool_call` | `pi.tool:*` span start + `tool_call` event | `pi.tool_call.count += 1` |
| `tool_result` | tool span event + tool span end | `pi.tool_result.count += 1`, `pi.tool.duration.record(...)` |
| `turn_end` | turn span end | `pi.turn.duration.record(...)`, token/cost accumulation |
| `agent_end` | agent span end | - |
| `session_shutdown` | session span end | `pi.session.duration.record(...)` |

## Cardinality Policy

Metric labels allow only the following by default:

- `provider`, `model`, `tool.name`, `success`, `type`

Default disallow list (high cardinality):

- raw prompt
- raw command
- raw session/file path

Record detailed context separately in trace attributes/events.

## Harness Tracking Extensions (Planned)

For personal harness experiment tracking, the following attributes are allowed.

- `harness.run_id`
- `harness.scenario_id`
- `harness.variant`
- `harness.dataset_id`

Principles:

- Record only low-cardinality derived values in metrics
- Record detailed experiment context in traces
