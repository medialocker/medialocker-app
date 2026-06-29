// Side-effect module: start OpenTelemetry (§18) before any instrumented
// library (Fastify/http, postgres, ioredis) is imported. Must be the FIRST
// import in the service entrypoint. No-op unless OTEL_EXPORTER_OTLP_ENDPOINT
// is set (§22).
import { initTelemetry } from "@medialocker/observability";

initTelemetry("api");
