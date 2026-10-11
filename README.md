# dsh-logger-channels

dsh-logger-channels gives a DSH profile a visible log sink: named channels that receive every `ctx.logger` record from the framework and all plugins, so runtime log output reaches the operator instead of ending only in the host's in-memory buffers.

- Named channels: stderr, stdout, and size-rotated files, each with its own level threshold
- One line per record in a fixed shape
- No tool surface and no config files of its own; channels are declared in the process env and/or a cordis config layer

## Installation

dsh-logger-channels is an out-of-tree plugin for a dsh profile. Install it with the dsh plugin command:

```sh
dsh plugin --profile <name> add dsh-logger-channels
```

Configuration is layered: built-in defaults, the `LOGGER_CHANNELS_*` process-env block, and a cordis config layer (see below).

## Configuration

One variable per channel declares it (`TYPE`); the rest attach to the declared channel and are optional:

| Variable | Required | Meaning |
|---|---|---|
| `LOGGER_CHANNELS_<NAME>_TYPE` | yes | declares channel `<name>` = the lowercased `<NAME>`; the value is `stderr`, `stdout`, or `file` |
| `LOGGER_CHANNELS_<NAME>_PATH` | file only | output file path (parent directories are created) |
| `LOGGER_CHANNELS_<NAME>_MINLEVEL` | no | numeric level threshold: 0 = error only, 1 = +info, 2 = +warn, 3 = +debug (default 2) |
| `LOGGER_CHANNELS_<NAME>_COLORS` | no | ANSI color level: `false` or 1-3 (default `false`) |
| `LOGGER_CHANNELS_<NAME>_MAXLENGTH` | no | per-line truncation in characters (default 10240) |
| `LOGGER_CHANNELS_<NAME>_MAXBYTES` | no (file) | size that triggers rotation, in bytes (default 10485760) |
| `LOGGER_CHANNELS_<NAME>_KEEP` | no (file) | number of rotated generations to keep (default 5) |

Example:

```
LOGGER_CHANNELS_APP_TYPE=file
LOGGER_CHANNELS_APP_PATH=/<path>
LOGGER_CHANNELS_APP_MINLEVEL=3
```

The `<NAME>` segment of the variable name is uppercase letters and digits only, and the channel name is its lowercased form; the channel name must match `^[a-z][a-z0-9-]{0,31}$`, so e.g. `LOGGER_CHANNELS_1APP_TYPE` declares no channel, and a lowercase segment such as `LOGGER_CHANNELS_app_TYPE` matches nothing at all. A key other than `TYPE` on a name that no `TYPE` variable declares is ignored, as are unknown keys in the namespace.

The level numbers follow cordis's verbosity ladder, not a severity ladder: `ERROR=0, INFO=1, WARN=2, DEBUG=3`. Note that `INFO` sorts numerically *before* `WARN`, the opposite of the log4j/Python severity convention. The config layer's `minLevel` uses the same numbering.

### Config layer (cordis patch)

An optional config layer sits on top of the env block: a patch entry targeting the plugin id `dsh-logger-channels` (the profile's `cordis.patch.yml`, the user-global `~/.dsh/cordis.patch.yml`, or a `--patch` overlay) carries a `config` object with one key, `channels` (a map of channel name to `channel`, `minLevel`, `colors`, `maxLength`, `path`, `maxBytes`, `keep`). Every key is optional.

```yaml
- id: dsh-logger-channels
  config:
    channels:
      app:
        channel: file
        path: /<path>
        minLevel: 3
```

- One precedence chain: config value > env value > built-in default; keys the layer omits resolve as the env block, so `config: {}` (or no entry) is exactly the env-only behavior.
- A patch targets a row by id and replaces its whole config - no deep merge, so a layer that overrides one field restates the fields it keeps (layer order: the plugin's own default entry, the profile patch, the user-global patch, any `--patch` overlay).
- Channels are the union of both layers; per key, the config layer wins.
- Config errors (unknown channel type, a file channel without `path`, an out-of-range value) fail the plugin entry at apply time with a labeled error, and the profile does not start.

## Line format

```
[2026-10-11T08:01:02.123Z] #42 INFO app Processing: scope=c2c peerId=1
```

Fields, in order: wall-clock timestamp (UTC), `#sn` (per-boot sequence number; resets on restart), level, logger name, body. In the body, an Error as the first argument renders its stack; the body is subject to the channel's `maxLength`.

## Limits

- File channels rotate on size: when a write would push the file past `maxBytes`, the live file is renamed to `.1` (the newest generation), older generations shift to `.2` ... `.keep`, and the oldest generation is dropped. Files are appended to, and the size counter is seeded from the existing file on open, so rotation continues across restarts.
- Runtime write failures never propagate to the host: a channel that cannot write (missing permissions, a full disk, a failed rotation) goes quiet and drops its own subsequent writes while the other channels keep working. A full disk is therefore silent on the affected channel - watch file modification times, not the log stream.
- `stdout` is a shared stream: in profiles where stdout carries a structured protocol, do not configure a `stdout` channel; stream ownership is the operator's to coordinate.
- When at least one channel is declared, the plugin logs one status line (level INFO) on start naming each channel and its threshold.
