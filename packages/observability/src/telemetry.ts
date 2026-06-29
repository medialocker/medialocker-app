import { NodeSDK } from '@opentelemetry/sdk-node';
import { Resource } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { trace, metrics, type Tracer, type Meter } from '@opentelemetry/api';
import { getConfig } from '@medialocker/config';

let _sdk: NodeSDK | null = null;
let _started = false;

/**
 * Initialise OpenTelemetry traces + metrics for a backend service (§18).
 *
 * No-op unless `OTEL_EXPORTER_OTLP_ENDPOINT` is configured (§22: "empty =
 * disabled"), so local/dev and tests run without a collector. When enabled it
 * starts a {@link NodeSDK} with OTLP/HTTP trace + metric exporters and Node
 * auto-instrumentations (http, pg, ioredis, …).
 *
 * For the instrumentations to patch the runtime, this must run **before** the
 * instrumented libraries are imported — each service imports its
 * `instrumentation.ts` (which calls this) as its very first import.
 *
 * Idempotent: safe to call more than once.
 */
export function initTelemetry(serviceName: string, version = '0.0.0'): void {
  if (_started) return;
  const config = getConfig();
  const endpoint = config.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (!endpoint) return;

  const base = endpoint.replace(/\/$/, '');

  _sdk = new NodeSDK({
    resource: new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: version,
    }),
    traceExporter: new OTLPTraceExporter({ url: `${base}/v1/traces` }),
    metricReader: new PeriodicExportingMetricReader({
      exporter: new OTLPMetricExporter({ url: `${base}/v1/metrics` }),
    }),
    instrumentations: [getNodeAutoInstrumentations()],
  });

  _sdk.start();
  _started = true;
}

/** True once {@link initTelemetry} has started an exporting SDK. */
export function isTelemetryEnabled(): boolean {
  return _started;
}

/** Acquire a tracer for manual spans. Returns a no-op tracer when telemetry
 * is disabled (the OTel API provides one), so call sites never branch. */
export function getTracer(name: string, version?: string): Tracer {
  return trace.getTracer(name, version);
}

/** Acquire a meter for custom metrics. No-op meter when disabled. */
export function getMeter(name: string, version?: string): Meter {
  return metrics.getMeter(name, version);
}

/** Flush + shut the SDK down on graceful termination. Safe when disabled, and
 * never throws — a failed final flush (e.g. unreachable collector) must not
 * block or fail the service's shutdown path. */
export async function shutdownTelemetry(): Promise<void> {
  if (!_sdk || !_started) return;
  try {
    await _sdk.shutdown();
  } catch {
    // best-effort flush; swallow so graceful shutdown always completes
  } finally {
    _started = false;
    _sdk = null;
  }
}
