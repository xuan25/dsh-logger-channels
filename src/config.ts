/**
 * Channel resolution: merge the env layer and the cordis config layer into
 * validated, defaults-filled channels.
 *
 * Layering (low to high): built-in defaults < env layer < config layer.
 * The env layer is `LOGGER_CHANNELS_<NAME>_<KEY>` (NAME = uppercase alphanumerics,
 * channel name = lowercased, must match the channel-name charset); the config
 * layer is `config.channels` (a named dictionary). Per key, the config layer
 * wins; a channel is the union of names declared by either layer.
 *
 * Config errors are labelled (`dsh-logger-channels: channel '<name>': <problem>`)
 * and thrown at apply time - fail-fast is deliberate here: a misconfigured
 * log sink is an operator error that must surface at startup, not degrade
 * silently mid-run (the opposite of ntfy's warn+drop, which is right for an
 * external push channel and wrong for the operator's own observability).
 */
import type { ChannelKind, ChannelSpec, EnvMap, LogColors, ResolvedChannel, SinkConfig } from './types.js';

/** Env var namespace prefix (mirrors dsh-ntfy's NTFY_ convention). */
export const ENV_PREFIX = 'LOGGER_CHANNELS_';

/** Valid channel names in every layer. */
export const CHANNEL_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;

const ENV_KEY_RE = /^([A-Z][A-Z0-9]*)_(TYPE|PATH|MINLEVEL|COLORS|MAXLENGTH|MAXBYTES|KEEP)$/;

export const DEFAULT_MIN_LEVEL = 2;
export const DEFAULT_MAX_LENGTH = 10240;
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_KEEP = 5;

/** Labelled config error; the message always names the offending channel. */
export class ConfigError extends Error {
  constructor(channel: string, problem: string) {
    super(`dsh-logger-channels: channel '${channel}': ${problem}`);
    this.name = 'ConfigError';
  }
}

function fail(channel: string, problem: string): never {
  throw new ConfigError(channel, problem);
}

function isChannelKind(value: unknown): value is ChannelKind {
  return value === 'stderr' || value === 'stdout' || value === 'file';
}

function isColors(value: unknown): value is LogColors {
  return value === false || (typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 3);
}

/**
 * Parse the env layer. A channel is DECLARED by `TYPE`; other keys are only
 * honored for names already declared by TYPE (in the env layer). Unknown keys
 * in the namespace are ignored by contract (the prefix may be shared).
 */
function parseEnvChannels(env: EnvMap): Map<string, ChannelSpec> {
  const out = new Map<string, ChannelSpec>();
  for (const [key, raw] of Object.entries(env)) {
    if (raw === undefined || !key.startsWith(ENV_PREFIX)) continue;
    const m = key.slice(ENV_PREFIX.length).match(ENV_KEY_RE);
    if (!m) continue;
    const name = m[1].toLowerCase();
    const k = m[2];
    if (!CHANNEL_NAME_RE.test(name)) {
      continue; // env segment charset already guarantees this; defensive only
    }
    let spec = out.get(name);
    if (k === 'TYPE') {
      if (!spec) {
        spec = {};
        out.set(name, spec);
      }
      if (!isChannelKind(raw)) fail(name, `TYPE must be 'stderr', 'stdout' or 'file' (got '${raw}')`);
      spec.channel = raw;
    } else {
      spec = out.get(name);
      if (!spec) continue; // non-TYPE key on an undeclared channel: ignored
    }
    switch (k) {
      case 'PATH':
        if (!raw) fail(name, 'PATH is empty');
        spec.path = raw;
        break;
      case 'MINLEVEL': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 0 || n > 3) fail(name, `MINLEVEL must be an integer 0-3 (got '${raw}')`);
        spec.minLevel = n;
        break;
      }
      case 'COLORS':
        if (raw === 'false' || raw === '0') spec.colors = false;
        else if (raw === '1') spec.colors = 1;
        else if (raw === '2') spec.colors = 2;
        else if (raw === '3') spec.colors = 3;
        else fail(name, `COLORS must be 'false' or 1-3 (got '${raw}')`);
        break;
      case 'MAXLENGTH': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) fail(name, `MAXLENGTH must be a positive integer (got '${raw}')`);
        spec.maxLength = n;
        break;
      }
      case 'MAXBYTES': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n <= 0) fail(name, `MAXBYTES must be a positive integer (got '${raw}')`);
        spec.maxBytes = n;
        break;
      }
      case 'KEEP': {
        const n = Number(raw);
        if (!Number.isInteger(n) || n < 1) fail(name, `KEEP must be an integer >= 1 (got '${raw}')`);
        spec.keep = n;
        break;
      }
    }
  }
  return out;
}

/**
 * Merge both layers into validated channels. Throws ConfigError (labelled) on
 * any violation - caller (apply) lets it propagate: startup fails, visibly.
 */
export function resolveChannels(config: SinkConfig, env: EnvMap): ResolvedChannel[] {
  const envChannels = parseEnvChannels(env);
  const cfgChannels = config.channels ?? {};
  const names = [...new Set([...Object.keys(cfgChannels), ...envChannels.keys()])];


  const channels: ResolvedChannel[] = [];
  for (const name of names) {
    if (!CHANNEL_NAME_RE.test(name)) {
      fail(name, 'invalid channel name (must match ^[a-z][a-z0-9-]{0,31}$)');
    }
    // Per-key merge: config layer present wins over env layer.
    const merged: ChannelSpec = { ...(envChannels.get(name) ?? {}), ...(cfgChannels[name] ?? {}) };

    if (merged.channel === undefined) {
      fail(name, 'declared without a channel type (need `channel` in the config layer or TYPE in the env layer)');
    }
    if (!isChannelKind(merged.channel)) {
      fail(name, `unknown channel type '${String(merged.channel)}' (expected stderr, stdout or file)`);
    }

    const minLevel = merged.minLevel ?? DEFAULT_MIN_LEVEL;
    if (!Number.isInteger(minLevel) || minLevel < 0 || minLevel > 3) {
      fail(name, `minLevel must be an integer 0-3 (got ${String(minLevel)})`);
    }
    const colors = merged.colors ?? false;
    if (!isColors(colors)) {
      fail(name, `colors must be false or 1-3 (got ${String(colors)})`);
    }
    const maxLength = merged.maxLength ?? DEFAULT_MAX_LENGTH;
    if (!Number.isInteger(maxLength) || maxLength <= 0) {
      fail(name, `maxLength must be a positive integer (got ${String(maxLength)})`);
    }

    if (merged.channel === 'file') {
      if (!merged.path) {
        fail(name, "channel type 'file' requires path");
      }
      const maxBytes = merged.maxBytes ?? DEFAULT_MAX_BYTES;
      if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
        fail(name, `maxBytes must be a positive integer (got ${String(maxBytes)})`);
      }
      const keep = merged.keep ?? DEFAULT_KEEP;
      if (!Number.isInteger(keep) || keep < 1) {
        fail(name, `keep must be an integer >= 1 (got ${String(keep)})`);
      }
      channels.push({ name, channel: merged.channel, minLevel, colors, maxLength, path: merged.path, maxBytes, keep });
    } else {
      channels.push({ name, channel: merged.channel, minLevel, colors, maxLength });
    }
  }
  return channels;
}
