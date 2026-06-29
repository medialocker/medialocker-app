interface Logger {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
  debug(obj: Record<string, unknown>, msg?: string): void;
}

function formatLog(level: string, obj: Record<string, unknown>, msg?: string): void {
  const entry = {
    level,
    time: new Date().toISOString(),
    ...obj,
    msg: msg || '',
  };
  const line = JSON.stringify(entry);
  if (level === 'error') {
    process.stderr.write(line + '\n');
  } else {
    process.stdout.write(line + '\n');
  }
}

function shouldLog(minLevel: string, current: string): boolean {
  const levels: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
  const min = levels[minLevel] ?? 20;
  const cur = levels[current] ?? 20;
  return cur >= min;
}

const logLevel = process.env['LOG_LEVEL'] || 'info';

export const logger: Logger = {
  info(obj, msg) {
    if (shouldLog(logLevel, 'info')) formatLog('info', obj, msg);
  },
  warn(obj, msg) {
    if (shouldLog(logLevel, 'warn')) formatLog('warn', obj, msg);
  },
  error(obj, msg) {
    if (shouldLog(logLevel, 'error')) formatLog('error', obj, msg);
  },
  debug(obj, msg) {
    if (shouldLog(logLevel, 'debug')) formatLog('debug', obj, msg);
  },
};
