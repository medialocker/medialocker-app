import type ffmpeg from 'fluent-ffmpeg';
import { logger } from './logger';

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

const FFMPEG_SANDBOX_OPTS = [
  '-err_detect', 'aggressive',
  '-max_alloc', '2000000000',
  '-threads', '2',
];

export const runningFfmpegCommands = new Set<ffmpeg.FfmpegCommand>();

export interface FfmpegRunOptions {
  timeoutMs?: number;
  logCtx?: Record<string, unknown>;
}

export async function runFfmpeg(
  cmd: ffmpeg.FfmpegCommand,
  opts: FfmpegRunOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  cmd.inputOptions(FFMPEG_SANDBOX_OPTS);

  let settled = false;

  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        const msg = `ffmpeg timed out after ${timeoutMs}ms`;
        logger.error({ ...opts.logCtx, timeoutMs }, msg);
        cmd.kill('SIGKILL');
        reject(new Error(msg));
      }
    }, timeoutMs);

    runningFfmpegCommands.add(cmd);

    cmd
      .on('end', () => {
        runningFfmpegCommands.delete(cmd);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve();
        }
      })
      .on('error', (err: Error) => {
        runningFfmpegCommands.delete(cmd);
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      })
      .run();
  });
}
