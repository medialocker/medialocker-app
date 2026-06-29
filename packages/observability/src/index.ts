import pino from 'pino';
import { getConfig } from '@medialocker/config';

let _logger: pino.Logger | null = null;

export function getLogger(): pino.Logger {
  if (!_logger) {
    const config = getConfig();
    _logger = pino({
      level: config.LOG_LEVEL,
      transport:
        config.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    });
  }
  return _logger;
}

export function createLogger(name: string, bindings?: Record<string, string>): pino.Logger {
  return getLogger().child({ component: name, ...bindings });
}

export function createContextLogger(
  name: string,
  opts?: {
    requestId?: string;
    orgId?: string;
    bucket?: string;
    op?: string;
    base?: Record<string, unknown>;
  },
): pino.Logger {
  const logBindings: Record<string, unknown> = {
    ...opts?.base,
  };
  if (opts?.requestId) logBindings['request_id'] = opts.requestId;
  if (opts?.orgId) logBindings['org_id'] = opts.orgId;
  if (opts?.bucket) logBindings['bucket'] = opts.bucket;
  if (opts?.op) logBindings['op'] = opts.op;
  return getLogger().child({ component: name, ...logBindings });
}

export function resetLogger(): void {
  _logger = null;
}

export type Logger = pino.Logger;

export {
  initTelemetry,
  shutdownTelemetry,
  isTelemetryEnabled,
  getTracer,
  getMeter,
} from './telemetry.js';
