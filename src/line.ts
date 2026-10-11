/**
 * One record -> one line, shared by every channel (format once, write N).
 *
 * Line shape (fixed), fields ordered outermost scope to innermost:
 *   [<ISO8601 UTC Z>] #<sn> <LEVEL> <name> <body>
 *     ts    = universal global scope (wall clock, comparable across launches)
 *     #sn   = launch scope (LoggerService counter: monotonic per process
 *             lifetime, survives plugin hot reload, resets on restart)
 *     LEVEL = line scope, closed set (ERROR/INFO/WARN/DEBUG)
 *     name  = line scope, open set (fiber-derived logger name)
 *
 * Within the line scope the closed-vocabulary field precedes the
 * open-vocabulary field (same convention as "METHOD /path" in access logs),
 * keeping the fixed-shape columns contiguous and the variable part at the tail.
 *
 * `body` is the message text via cordis `Logger.format`: printf placeholders
 * (%s/%d/%o/%C via defaultFormatters), an Error first argument becomes its
 * stack, trailing objects are JSON-joined, and each line is truncated to the
 * channel's maxLength (cordis default 10240). The record's structured `meta`
 * (fiber WeakRef and friends) is internal tracing data and is never rendered.
 *
 * When a record has no args at all, cordis `Logger.format` would collapse to
 * the artifact "undefined"; an empty body is therefore rendered as nothing
 * and the line is just the prefix.
 */
import { Logger } from '@deepseek-ai/cordis';
import type { Exporter, Message } from '@deepseek-ai/cordis';
import type { ResolvedChannel } from './types.js';

function isoUtc(ts: number): string {
  return new Date(ts).toISOString();
}

/** Render one log record for the given channel (no trailing newline). */
export function renderLine(ch: ResolvedChannel, message: Message): string {
  const prefix = `[${isoUtc(message.ts)}] #${message.sn} ${message.type.toUpperCase()} ${message.name}`;
  if (message.args.length === 0) return prefix;
  // The channel's own color/maxLength settings are exactly what Logger.format
  // reads from its exporter argument, so pass a minimal exporter view.
  const formatOpts: Exporter = {
    colors: ch.colors,
    maxLength: ch.maxLength,
    export: () => {},
  };
  const body = Logger.format(formatOpts, message);
  return body ? `${prefix} ${body}` : prefix;
}
