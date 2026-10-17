# pi-opentelemetry

Pi usage observability extension project.

## Essentials

- Observability scope must include **Trace + Metrics + Diagnostics**.
- The default privacy profile is **detailed-with-redaction**.
- Collect detailed payloads, but sensitive-data masking is mandatory.
- Keep metrics low-cardinality, and record rich context primarily in traces.
- Keep operational diagnostics commands (`/otel-status`, `/otel-open-trace`) as baseline functionality.

## Documents

- Documentation index: [docs/index.md](docs/index.md)
- OTel architecture/event mapping: [docs/otel-architecture.md](docs/otel-architecture.md)
- Privacy/redaction policy: [docs/privacy-redaction.md](docs/privacy-redaction.md)
- Operations/diagnostics guide: [docs/operations.md](docs/operations.md)
- Documentation governance standard: [docs/metadoc.md](docs/metadoc.md)
