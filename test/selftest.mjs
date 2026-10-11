// dsh-logger-channels selftest - pure-function probes against the built lib/.
// Run: pnpm selftest  (after pnpm build). No cordis fiber is booted; only the
// cordis Logger static formatter is exercised, which is a pure function.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { name, renderLine, resolveChannels, RotatingFile } from '../lib/index.js';

let passed = 0;
function check(label, fn) {
  fn();
  passed += 1;
  console.log(`ok - ${label}`);
}

const TS = Date.UTC(2026, 9, 11, 8, 1, 2, 123); // 2026-10-11T08:01:02.123Z
const msg = (over = {}) => ({
  sn: 42,
  ts: TS,
  name: 'im-qqbot',
  type: 'info',
  level: 1,
  args: ['Processing: scope=c2c peerId=1 body="hi"'],
  ...over,
});
const chStderr = { name: 'main', channel: 'stderr', minLevel: 2, colors: false, maxLength: 10240 };
// Everything after the name field (the last fixed-shape column).
const bodyOf = (line) => line.slice(line.indexOf(' im-qqbot ') + ' im-qqbot '.length);

// -- identity ----------------------------------------------------------------
check('plugin id is dsh-logger-channels', () => assert.equal(name, 'dsh-logger-channels'));

// -- empty declaration -------------------------------------------------------
check('no declared channel in either layer resolves to zero channels (plugin inert)', () => {
  assert.deepEqual(resolveChannels({}, {}), []);
});
check('empty channels dict (not absent) also resolves to zero channels', () => {
  assert.deepEqual(resolveChannels({ channels: {} }, {}), []);
});

// -- config layer ------------------------------------------------------------
check('config layer: two channels resolve with defaults filled', () => {
  const got = resolveChannels(
    { channels: { main: { channel: 'stderr', minLevel: 0 }, audit: { channel: 'file', path: '/var/log/dsh/app.log' } } },
    {},
  );
  assert.deepEqual(got, [
    { name: 'main', channel: 'stderr', minLevel: 0, colors: false, maxLength: 10240 },
    { name: 'audit', channel: 'file', minLevel: 2, colors: false, maxLength: 10240, path: '/var/log/dsh/app.log', maxBytes: 10485760, keep: 5 },
  ]);
  assert.equal(got[0].minLevel, 0); // as given
  assert.equal(got[1].minLevel, 2); // default filled
  assert.equal(got[1].maxBytes, 10 * 1024 * 1024);
  assert.equal(got[1].keep, 5);
});

// -- env layer ---------------------------------------------------------------
check('env layer alone declares channels (TYPE declares, others attach)', () => {
  const env = {
    LOGGER_CHANNELS_AUDIT_TYPE: 'file',
    LOGGER_CHANNELS_AUDIT_PATH: '/tmp/a.log',
    LOGGER_CHANNELS_AUDIT_MINLEVEL: '3',
    LOGGER_CHANNELS_AUDIT_KEEP: '2',
    LOGGER_CHANNELS_STD_TYPE: 'stderr',
  };
  const got = resolveChannels({}, env);
  assert.equal(got.length, 2);
  const audit = got.find((c) => c.name === 'audit');
  assert.deepEqual(audit, { name: 'audit', channel: 'file', minLevel: 3, colors: false, maxLength: 10240, path: '/tmp/a.log', maxBytes: 10485760, keep: 2 });
  assert.equal(got.find((c) => c.name === 'std').channel, 'stderr');
});
check('non-TYPE env key on an undeclared name is ignored (no phantom channel, no default)', () => {
  const got = resolveChannels({}, { LOGGER_CHANNELS_GHOST_PATH: '/tmp/ghost.log' });
  assert.deepEqual(got, []);
});

// -- layering: config layer wins per key -------------------------------------
check('config layer overrides env layer per key (path, minLevel)', () => {
  const env = { LOGGER_CHANNELS_AUDIT_TYPE: 'file', LOGGER_CHANNELS_AUDIT_PATH: '/tmp/env.log', LOGGER_CHANNELS_AUDIT_MINLEVEL: '3' };
  const got = resolveChannels({ channels: { audit: { channel: 'file', path: '/tmp/cfg.log', minLevel: 2 } } }, env);
  assert.equal(got.length, 1);
  assert.equal(got[0].path, '/tmp/cfg.log'); // config wins
  assert.equal(got[0].minLevel, 2); // config wins
});
check('config layer may extend an env-declared channel with missing keys', () => {
  const env = { LOGGER_CHANNELS_AUDIT_TYPE: 'file' };
  const got = resolveChannels({ channels: { audit: { path: '/tmp/j.log' } } }, env);
  assert.equal(got[0].path, '/tmp/j.log');
  assert.equal(got[0].channel, 'file');
});
check('channels are the union of both layers', () => {
  const env = { LOGGER_CHANNELS_FROMENV_TYPE: 'stderr' };
  const got = resolveChannels({ channels: { fromcfg: { channel: 'stdout' } } }, env);
  assert.deepEqual(got.map((c) => c.name).sort(), ['fromcfg', 'fromenv']);
});

// -- fail-fast matrix (labelled errors) -------------------------------------
const fails = [
  ['file channel without path', { channels: { a: { channel: 'file' } } }, {}],
  ['file channel with empty path', { channels: { a: { channel: 'file', path: '' } } }, {}],
  ['unknown channel kind', { channels: { a: { channel: 'syslog' } } }, {}],
  ['minLevel out of range', { channels: { a: { channel: 'stderr', minLevel: 5 } } }, {}],
  ['negative minLevel', { channels: { a: { channel: 'stderr', minLevel: -1 } } }, {}],
  ['invalid colors', { channels: { a: { channel: 'stderr', colors: 7 } } }, {}],
  ['maxLength zero', { channels: { a: { channel: 'stderr', maxLength: 0 } } }, {}],
  ['maxBytes zero', { channels: { a: { channel: 'file', path: '/x', maxBytes: 0 } } }, {}],
  ['keep zero', { channels: { a: { channel: 'file', path: '/x', keep: 0 } } }, {}],
  ['invalid channel name (leading digit)', { channels: { '9bad': { channel: 'stderr' } } }, {}],
  ['declared without a type', { channels: { a: { minLevel: 1 } } }, {}],
  ['env TYPE invalid', {}, { LOGGER_CHANNELS_BAD_TYPE: 'syslog' }],
  ['env MINLEVEL invalid', {}, { LOGGER_CHANNELS_BAD_TYPE: 'stderr', LOGGER_CHANNELS_BAD_MINLEVEL: 'x' }],
  ['env MAXBYTES invalid', {}, { LOGGER_CHANNELS_BAD_TYPE: 'file', LOGGER_CHANNELS_BAD_PATH: '/x', LOGGER_CHANNELS_BAD_MAXBYTES: '-5' }],
];
for (const [label, cfg, env] of fails) {
  check(`fail-fast: ${label}`, () => {
    assert.throws(() => resolveChannels(cfg, env), (e) => e instanceof Error && /^dsh-logger-channels: channel '/.test(e.message));
  });
}

// -- line rendering ----------------------------------------------------------
check('line shape: [ISO UTC Z] #sn LEVEL name body (scope order: global > launch > line)', () => {
  const line = renderLine(chStderr, msg());
  assert.equal(line, `[${new Date(TS).toISOString()}] #42 INFO im-qqbot Processing: scope=c2c peerId=1 body="hi"`);
});
check('printf placeholders resolve (%s %d)', () => {
  const line = renderLine(chStderr, msg({ args: ['x=%s y=%d', 'a', 7] }));
  assert.equal(bodyOf(line), 'x=a y=7');
});
check('Error first arg renders its stack (multi-line body preserved)', () => {
  const line = renderLine(chStderr, msg({ args: [new Error('boom')] }));
  assert.ok(line.includes('Error: boom'));
  assert.ok(!line.includes('%'));
  assert.ok(line.split('\n').length > 2);
});
check('empty args renders prefix only (no "undefined" artifact)', () => {
  const line = renderLine(chStderr, msg({ args: [] }));
  assert.equal(line, `[${new Date(TS).toISOString()}] #42 INFO im-qqbot`);
});
check('maxLength truncates per line with ellipsis', () => {
  const ch = { ...chStderr, maxLength: 20 };
  const line = renderLine(ch, msg({ args: ['x'.repeat(100)] }));
  const body = bodyOf(line);
  assert.ok(body.endsWith('...'));
  assert.ok(body.length <= 23); // 20 + '...'
});
check('structured meta (fiber WeakRef) is never rendered', () => {
  const line = renderLine(chStderr, msg({ args: ['plain'] }));
  assert.ok(!/fiber|WeakRef/i.test(line));
});

// -- file channel: rotation --------------------------------------------------
const dir = mkdtempSync(join(tmpdir(), 'logger-sink-selftest-'));
try {
  check('file writer: parent dirs auto-created, appends UTF-8', () => {
    const p = join(dir, 'nested', 'deep', 'a.log');
    const f = new RotatingFile(p, 1024, 2);
    f.open();
    f.write('h\u00E9llo\n');
    f.close();
    assert.equal(readFileSync(p, 'utf8'), 'h\u00E9llo\n');
  });

  check('rotation: size-based, .1 newest, keep caps generations', () => {
    const p = join(dir, 'rot.log');
    const f = new RotatingFile(p, 60, 2);
    f.open();
    f.write('A'.repeat(40) + '\n'); // 41 B, no rotation
    f.write('B'.repeat(40) + '\n'); // 41+41=82 > 60 -> rotate
    f.write('C'.repeat(40) + '\n'); // 41+41=82 > 60 -> rotate again
    f.close();
    assert.equal(readFileSync(p, 'utf8'), 'C'.repeat(40) + '\n');
    assert.equal(readFileSync(`${p}.1`, 'utf8'), 'B'.repeat(40) + '\n');
    assert.equal(readFileSync(`${p}.2`, 'utf8'), 'A'.repeat(40) + '\n');
    assert.ok(!existsSync(`${p}.3`), 'keep=2 must drop the oldest generation');
  });

  check('rotation counter seeds from fstat (pre-existing content respected)', () => {
    const p = join(dir, 'seed.log');
    const f = new RotatingFile(p, 60, 2);
    f.open();
    f.write('A'.repeat(50) + '\n'); // 51 B existing content after open
    f.write('B'.repeat(10) + '\n'); // 51+11=62 > 60 -> rotate
    f.close();
    assert.equal(readFileSync(p, 'utf8'), 'B'.repeat(10) + '\n');
    assert.equal(readFileSync(`${p}.1`, 'utf8'), 'A'.repeat(50) + '\n');
  });

  check('writer goes quiet on failure instead of throwing (never takes down host)', () => {
    // A plain file named "blocker" makes its "child dir" uncreatable:
    // open() must fail into the quiet state, write() a silent no-op.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'i am a file, not a dir');
    const bad = new RotatingFile(join(blocker, 'child.log'), 60, 2);
    bad.open(); // mkdirSync -> ENOTDIR -> fd null (quiet)
    bad.write('y\n'); // silent no-op
    bad.close(); // idempotent
    assert.ok(!existsSync(join(blocker, 'child.log')));
  });
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// -- size bookkeeping is byte-exact (multibyte) -----------------------------
{
  const dir2 = mkdtempSync(join(tmpdir(), 'logger-sink-selftest-'));
  try {
    check('byte counter counts UTF-8 bytes, not JS chars', () => {
      const p = join(dir2, 'mb.log');
      const HAN = String.fromCharCode(0x4E2D); // one 3-byte UTF-8 char (U+4E2D)
      const f = new RotatingFile(p, 12, 2);
      f.open();
      f.write((HAN + HAN + '\n').repeat(2)); // 14 B > 12: rotation must fire on bytes (7 chars < 12 would not)
      f.close();
      assert.ok(existsSync(`${p}.1`), 'rotation must have fired on byte size');
      assert.ok(readFileSync(p, 'utf8').length > 0);
    });
  } finally {
    rmSync(dir2, { recursive: true, force: true });
  }
}

console.log(`\n# selftest: ${passed} passed`);
