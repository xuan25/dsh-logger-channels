/**
 * dsh-logger-channels - visible log sink for the cordis ctx.logger service.
 *
 * The dsh host ships only in-memory log sinks (cordis ring buffer, startup
 * diagnostics buffer surfaced on boot failure). Without this plugin, all
 * `ctx.logger` calls from the framework and every plugin - including the
 * dsh-im-qqbot lifecycle lines (apply, Bot ready, gateway events) and
 * per-message lines - go to memory and are never seen. This plugin registers
 * the operator's visible sink(s): named stderr/stdout/file channels with
 * per-channel level thresholds and size rotation (see README).
 *
 * No tool surface, no skill: it is a pure sink, configured via the cordis
 * config tree (patch layers) and the LOGGER_CHANNELS_* env layer.
 */
import type { Context } from '@deepseek-ai/cordis';
import { applySink } from './apply.js';
import type { SinkConfig } from './types.js';

/** Cordis plugin id (must match the patch row id). */
export const name = 'dsh-logger-channels';

export function apply(ctx: Context, config: SinkConfig = {}): void {
  applySink(ctx, config);
}

// Public surface (used by the selftest and by operators who want the pure
// functions without booting a fiber).
export { ConfigError, DEFAULT_KEEP, DEFAULT_MAX_BYTES, DEFAULT_MAX_LENGTH, DEFAULT_MIN_LEVEL, resolveChannels } from './config.js';
export { RotatingFile } from './file-channel.js';
export { renderLine } from './line.js';
export type { ChannelKind, ChannelSpec, EnvMap, LogColors, ResolvedChannel, SinkConfig } from './types.js';
