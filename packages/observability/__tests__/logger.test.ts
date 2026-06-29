import { describe, it, expect } from 'vitest';
import { getLogger, createLogger, createContextLogger } from '../src/index.js';

describe('getLogger', () => {
  it('returns a pino logger', () => {
    const logger = getLogger();
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.warn).toBe('function');
  });

  it('returns the same logger on repeated calls', () => {
    const logger1 = getLogger();
    const logger2 = getLogger();
    expect(logger1).toBe(logger2);
  });
});

describe('createLogger', () => {
  it('creates a child logger with component name', () => {
    const logger = createLogger('test-component');
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });
});

describe('createContextLogger', () => {
  it('creates a logger with request context', () => {
    const logger = createContextLogger('api', {
      requestId: 'req-123',
      orgId: 'org-456',
    });
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
  });
});
