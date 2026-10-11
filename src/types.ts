/**
 * dsh-logger-channels shared types.
 *
 * A channel is a named, independent output path for ctx.logger records.
 * Channel kinds: `stderr` / `stdout` (process streams) and `file` (a
 * size-rotated file). Each channel carries its own level threshold, so one
 * deployment can e.g. keep stderr at error/info/warn while a file channel
 * captures everything including debug.
 */

/** Cordis exporter `colors` semantics, passed through verbatim. */
export type LogColors = false | 1 | 2 | 3;

/** Output channel kinds. */
export type ChannelKind = 'stderr' | 'stdout' | 'file';

/**
 * Flat per-channel settings. All keys optional except `channel` (and `path`
 * when `channel === 'file'`); defaults are filled by `resolveChannels`.
 * The same shape is produced by the env layer (parsed) and consumed from the
 * cordis config layer (as written in the profile patch).
 */
export interface ChannelSpec {
  /** Output kind. Env layer: `TYPE`. */
  channel?: ChannelKind;
  /** Export records whose numeric level is <= this (cordis: ERROR=0, INFO=1, WARN=2, DEBUG=3). Default 2. Env: `MINLEVEL`. */
  minLevel?: number;
  /** ANSI color level, cordis `colors` semantics (false = plain). Default false. Env: `COLORS`. */
  colors?: LogColors;
  /** Per-line truncation in characters (cordis `maxLength`). Default 10240 (cordis default). Env: `MAXLENGTH`. */
  maxLength?: number;
  /** File path (required when `channel === 'file'`; created/appended, parent dirs auto-created). Env: `PATH`. */
  path?: string;
  /** File channel: rotate when the file would exceed this many bytes. Default 10 MiB. Env: `MAXBYTES`. */
  maxBytes?: number;
  /** File channel: number of rotated generations to keep (`.1` newest). Default 5. Env: `KEEP`. */
  keep?: number;
}

/** Plugin config as received from the cordis config tree (patch layers). */
export interface SinkConfig {
  /**
   * Named channels. When this is absent/empty AND the env layer declares
   * nothing, a single default channel is injected: `default` = stderr @ 2.
   */
  channels?: Record<string, ChannelSpec>;
}

/** A validated channel with all defaults filled. */
export interface ResolvedChannel {
  name: string;
  channel: ChannelKind;
  minLevel: number;
  colors: LogColors;
  maxLength: number;
  path?: string;
  maxBytes?: number;
  keep?: number;
}

/** Process env view (plain object; `process.env` is passed in production). */
export interface EnvMap {
  [key: string]: string | undefined;
}
