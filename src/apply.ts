/**
 * applySink - register every resolved channel on the cordis ctx.logger
 * service.
 *
 * Wiring facts (cordis >=4.0.1):
 *  - LoggerService is always present on ctx; each `ctx.logger.exporter(e)`
 *    call registers an effect-scoped exporter that is removed automatically
 *    when the plugin's fiber disposes (hot reload / context shutdown).
 *  - The dispatch loop has NO try/catch around exporter export calls, so
 *    every write path below is guarded and failures are swallowed silently:
 *    a broken channel degrades to "no output on that channel", never a crash.
 *  - File fds are owned by our own ctx.effect (registered after the
 *    exporter's): LIFO disposal closes the fd before the exporter is
 *    removed, and the writer's quiet-state check makes any interleaved
 *    dispatch safe.
 *
 * Records are gated per channel by `levels: { default: minLevel }` (cordis
 * exports when the record level <= threshold). One format pass feeds every
 * channel (each channel may truncate at its own maxLength).
 */
import type { Context, Exporter, LoggerService, Message } from '@deepseek-ai/cordis';
import { resolveChannels } from './config.js';
import { RotatingFile } from './file-channel.js';
import { renderLine } from './line.js';
import type { EnvMap, ResolvedChannel, SinkConfig } from './types.js';

export function applySink(ctx: Context, config: SinkConfig, env: EnvMap = process.env): void {
  // Fail-fast: ConfigError propagates out of apply -> the profile refuses to
  // start with the labelled message. Deliberate (see src/config.ts).
  const channels = resolveChannels(config, env);

  if (channels.length === 0) {
    return;
  }

  const logger = (ctx as unknown as { logger: LoggerService }).logger;
  const effects = ctx as unknown as {
    effect(dispose: () => void | (() => void | Promise<void>), name?: string): void;
  };

  for (const ch of channels) {
    let writeLine: (line: string) => void;
    if (ch.channel === 'file') {
      const file = new RotatingFile(ch.path as string, ch.maxBytes as number, ch.keep as number);
      effects.effect(() => {
        file.open();
        return () => file.close();
      }, `dsh-logger-channels:file:${ch.name}`);
      writeLine = (line) => {
        try {
          file.write(line);
        } catch {
          // writer-level failure: it has already gone quiet; nothing to do
        }
      };
    } else {
      const stream = ch.channel === 'stderr' ? process.stderr : process.stdout;
      writeLine = (line) => {
        try {
          stream.write(line);
        } catch {
          // broken pipe / closed stream: channel degrades silently
        }
      };
    }

    const exporter: Exporter = {
      levels: { default: ch.minLevel },
      colors: ch.colors,
      maxLength: ch.maxLength,
      export(message: Message): void {
        let line: string;
        try {
          line = renderLine(ch, message);
        } catch {
          return; // formatting must never take down the host
        }
        writeLine(`${line}\n`);
      },
    };
    logger.exporter(exporter);
  }

  // Self-announce: proves the sink is live and its shape at a glance. Each
  // channel's own threshold applies (a channel at minLevel 0 will not echo
  // this info line onto itself - consistent with its declared scope).
  const summary = channels
    .map((c: ResolvedChannel) => `${c.name}=${c.channel}${c.channel === 'file' ? `:${c.path}` : ''}@<=${c.minLevel}`)
    .join(', ');
  logger.info(`dsh-logger-channels active: ${summary}`);
}
