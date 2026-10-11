/**
 * Appending file writer with pure size-based rotation.
 *
 * Rotation chain: the live file grows until a write would push it past
 * `maxBytes`; then `.1` -> `.2` -> ... -> `.keep` are shifted, the oldest
 * generation (`.keep`) is dropped, and the live file is renamed to `.1`.
 * The live file is recreated empty. Append mode ('a'); the in-memory byte
 * counter is seeded from fstat on open so a hot-reload re-registration
 * continues after any existing content instead of resetting the rotation
 * clock.
 *
 * The writer is best-effort by contract: any fs failure (including a failed
 * rotation) puts it into a quiet state (fd = null) and subsequent writes are
 * dropped silently. A log sink must never take down the host process - the
 * cordis dispatch loop has no per-exporter isolation.
 *
 * Single-writer invariant: exactly one process holds the fd (the dsh host);
 * the in-memory counter is therefore byte-exact for its own writes.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

export class RotatingFile {
  private fd: number | null = null;
  private size = 0;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(path: string, maxBytes: number, keep: number) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.keep = keep;
  }

  /** Create parent dirs and open for append; seeds the size counter. */
  open(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      this.fd = openSync(this.path, 'a');
      this.size = fstatSync(this.fd).size;
    } catch {
      this.fd = null;
    }
  }

  /** Close the fd (idempotent; safe after a quiet-state failure). */
  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        // fd already gone - nothing to do
      }
      this.fd = null;
    }
  }

  /** Write one UTF-8 line (caller adds the newline); rotates first if needed. */
  write(data: string): void {
    if (this.fd === null) return;
    const bytes = Buffer.byteLength(data, 'utf8');
    if (this.size + bytes > this.maxBytes) {
      this.rotate();
    }
    if (this.fd === null) return;
    // The fd is opened O_APPEND ('a'), so position is irrelevant; pass null
    // explicitly because the string overload types position as a required
    // (nullable) slot before the encoding.
    this.size += writeSync(this.fd, data, null, 'utf8');
  }

  private rotate(): void {
    try {
      if (this.fd !== null) {
        closeSync(this.fd);
        this.fd = null;
      }
      const oldest = `${this.path}.${this.keep}`;
      if (existsSync(oldest)) unlinkSync(oldest);
      for (let i = this.keep - 1; i >= 1; i--) {
        const from = `${this.path}.${i}`;
        if (existsSync(from)) renameSync(from, `${this.path}.${i + 1}`);
      }
      renameSync(this.path, `${this.path}.1`);
      this.fd = openSync(this.path, 'a');
      this.size = 0;
    } catch {
      // Rotation failed (permissions, ENOSPC...): writer goes quiet.
      this.fd = null;
    }
  }
}
