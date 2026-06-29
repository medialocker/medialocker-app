import { afterEach, describe, it, expect, vi } from 'vitest';
import {
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  getTracer,
  getMeter,
} from '../src/index.js';
import { resetConfig } from '@medialocker/config';

// Each test controls OTEL_EXPORTER_OTLP_ENDPOINT via env, so reset the cached
// config + SDK state between cases.
afterEach(async () => {
  await shutdownTelemetry();
  delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  resetConfig();
  vi.restoreAllMocks();
});

describe('initTelemetry', () => {
  it('is a no-op (disabled) when OTEL_EXPORTER_OTLP_ENDPOINT is unset (§22)', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    resetConfig();
    initTelemetry('test-svc');
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('starts an exporting SDK when an endpoint is configured', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    resetConfig();
    initTelemetry('test-svc', '1.2.3');
    expect(isTelemetryEnabled()).toBe(true);
  });

  it('is idempotent — a second call does not start a second SDK', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    resetConfig();
    initTelemetry('test-svc');
    initTelemetry('test-svc');
    expect(isTelemetryEnabled()).toBe(true);
  });
});

describe('shutdownTelemetry', () => {
  it('disables telemetry and never throws even with an unreachable collector', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://127.0.0.1:4318';
    resetConfig();
    initTelemetry('test-svc');
    expect(isTelemetryEnabled()).toBe(true);
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
    expect(isTelemetryEnabled()).toBe(false);
  });

  it('is safe to call when telemetry was never started', async () => {
    await expect(shutdownTelemetry()).resolves.toBeUndefined();
  });
});

describe('getTracer / getMeter', () => {
  it('return working API objects even when telemetry is disabled (no-op)', () => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    resetConfig();
    initTelemetry('test-svc');
    const tracer = getTracer('unit');
    const span = tracer.startSpan('op');
    expect(() => span.end()).not.toThrow();
    const meter = getMeter('unit');
    const counter = meter.createCounter('things');
    expect(() => counter.add(1)).not.toThrow();
  });
});
