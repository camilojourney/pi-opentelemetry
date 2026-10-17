import { resourceFromAttributes } from "@opentelemetry/resources";
import type { TelemetryConfig } from "./types.js";

/** One service identity policy for trace and metric resources. */
export function telemetryResource(config: TelemetryConfig) {
  return resourceFromAttributes({ ...config.resourceAttributes,
    "service.name": config.serviceName, "service.version": config.serviceVersion });
}
