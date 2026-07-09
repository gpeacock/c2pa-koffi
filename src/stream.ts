// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi, { IKoffiRegisteredCallback } from 'koffi';
import { openSync, closeSync, readSync, writeSync, fstatSync, constants as fsConstants } from 'fs';
import {
  getLib,
  ReadCallbackProto,
  SeekCallbackProto,
  WriteCallbackProto,
  FlushCallbackProto,
  toNum,
} from './lib.js';
import { checkPtr } from './error.js';

/** Backing store for a C2paStream. Tracks its own read/write position. */
interface StreamBackend {
  read(out: Buffer): number;
  write(data: Buffer): number;
  seek(offset: number, mode: number): number;
  size(): number;
  close(): void;
  /** Only meaningful for in-memory backends. */
  getBytes?(): Buffer;
}

/** In-memory backend. Grows on write; the whole asset is held in JS memory. */
class BufferBackend implements StreamBackend {
  private _buf: Buffer;
  private _pos = 0;
  private _size: number;

  constructor(buf: Buffer, size: number) {
    this._buf = buf;
    this._size = size;
  }

  read(out: Buffer): number {
    const available = Math.min(out.length, this._size - this._pos);
    if (available <= 0) return 0;
    this._buf.copy(out, 0, this._pos, this._pos + available);
    this._pos += available;
    return available;
  }

  write(data: Buffer): number {
    const end = this._pos + data.length;
    this._ensureCapacity(end);
    data.copy(this._buf, this._pos);
    this._pos += data.length;
    if (this._pos > this._size) this._size = this._pos;
    return data.length;
  }

  seek(offset: number, mode: number): number {
    const newPos = seekTo(offset, mode, this._pos, this._size);
    if (newPos < 0) return -1;
    return (this._pos = newPos);
  }

  size(): number {
    return this._size;
  }

  close(): void {}

  getBytes(): Buffer {
    return this._buf.subarray(0, this._size);
  }

  private _ensureCapacity(needed: number): void {
    if (needed <= this._buf.length) return;
    const newBuf = Buffer.alloc(Math.max(needed, this._buf.length * 2));
    this._buf.copy(newBuf, 0, 0, this._size);
    this._buf = newBuf;
  }
}

/**
 * File-descriptor backend. Reads/writes go straight to disk at an explicit
 * position (the fd's own cursor is left untouched), so assets of any size
 * can be processed without ever holding the whole file in memory.
 */
class FileBackend implements StreamBackend {
  private readonly _fd: number;
  private _pos = 0;
  private _size: number;

  constructor(fd: number, initialSize: number) {
    this._fd = fd;
    this._size = initialSize;
  }

  read(out: Buffer): number {
    const n = readSync(this._fd, out, 0, out.length, this._pos);
    this._pos += n;
    return n;
  }

  write(data: Buffer): number {
    const n = writeSync(this._fd, data, 0, data.length, this._pos);
    this._pos += n;
    if (this._pos > this._size) this._size = this._pos;
    return n;
  }

  seek(offset: number, mode: number): number {
    const newPos = seekTo(offset, mode, this._pos, this._size);
    if (newPos < 0) return -1;
    return (this._pos = newPos);
  }

  size(): number {
    return this._size;
  }

  close(): void {
    closeSync(this._fd);
  }
}

function seekTo(offset: number, mode: number, pos: number, size: number): number {
  switch (mode) {
    case 0: return offset;        // Start
    case 1: return pos + offset;  // Current
    case 2: return size + offset; // End
    default: return -1;
  }
}

/**
 * Seekable stream bridged to the C2PA C API via koffi callbacks.
 *
 * Backed by either an in-memory Buffer/byte array or a file descriptor.
 * The same instance handles read+write+seek, which is required for the
 * sign destination stream (c2pa may seek back to patch the manifest slot).
 *
 * This is an internal type — users work with plain Buffers or file paths.
 */
export class C2paStream {
  // Native C2paStream* — passed directly to C API functions.
  readonly ptr: unknown;

  private readonly _backend: StreamBackend;
  private _disposed = false;

  // Koffi callback handles — must stay alive as long as the native stream exists.
  private readonly _cbs: IKoffiRegisteredCallback[];
  // Reused scratch buffer for read callbacks, to avoid a per-call allocation.
  private _scratch = Buffer.alloc(64 * 1024);

  private constructor(backend: StreamBackend) {
    this._backend = backend;

    // koffi.register() requires koffi.pointer(proto) as the second argument
    const readCb = koffi.register(
      (_ctx: unknown, outPtr: unknown, len: number | bigint): number => {
        try {
          const n = toNum(len);
          if (this._scratch.length < n) this._scratch = Buffer.alloc(n);
          const actual = this._backend.read(this._scratch.subarray(0, n));
          if (actual <= 0) return 0;
          koffi.encode(outPtr, 'uint8_t', this._scratch.subarray(0, actual), actual);
          return actual;
        } catch {
          return -1;
        }
      },
      koffi.pointer(ReadCallbackProto),
    );

    const seekCb = koffi.register(
      (_ctx: unknown, offset: number | bigint, mode: number): number => {
        try {
          return this._backend.seek(toNum(offset), mode);
        } catch {
          return -1;
        }
      },
      koffi.pointer(SeekCallbackProto),
    );

    const writeCb = koffi.register(
      (_ctx: unknown, inPtr: unknown, len: number | bigint): number => {
        try {
          const n = toNum(len);
          const arr = koffi.decode(inPtr, 'uint8_t', n) as Uint8Array;
          return this._backend.write(Buffer.from(arr));
        } catch {
          return -1;
        }
      },
      koffi.pointer(WriteCallbackProto),
    );

    const flushCb = koffi.register(
      (_ctx: unknown): number => 0,
      koffi.pointer(FlushCallbackProto),
    );

    this._cbs = [readCb, seekCb, writeCb, flushCb];
    this.ptr = checkPtr(
      getLib().c2pa_create_stream(null, readCb, seekCb, writeCb, flushCb),
      'Failed to create C2paStream',
    );
  }

  /**
   * Create a read/write/seek stream over an existing Buffer or byte array.
   * The stream aliases `data`'s memory (no copy) — do not mutate `data`
   * while the stream is in use.
   */
  static fromBuffer(data: Buffer | Uint8Array): C2paStream {
    const buf = Buffer.isBuffer(data)
      ? data
      : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    return new C2paStream(new BufferBackend(buf, buf.length));
  }

  /** Create a writable (also seekable/readable) in-memory stream with an initial capacity. */
  static writable(initialCapacity = 4 * 1024 * 1024): C2paStream {
    return new C2paStream(new BufferBackend(Buffer.alloc(initialCapacity), 0));
  }

  /**
   * Open an existing file for reading (read/seek only — writes will fail).
   * Bytes are streamed directly from disk; the file is never fully buffered.
   */
  static fromFile(path: string): C2paStream {
    const fd = openSync(path, fsConstants.O_RDONLY);
    const size = fstatSync(fd).size;
    return new C2paStream(new FileBackend(fd, size));
  }

  /**
   * Open (creating/truncating) a file as a read+write+seek destination stream,
   * e.g. for signing output. Bytes are written directly to disk.
   */
  static toFile(path: string): C2paStream {
    const fd = openSync(path, fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_TRUNC);
    return new C2paStream(new FileBackend(fd, 0));
  }

  /** Return a copy of the bytes written so far. Only valid for in-memory streams. */
  getBytes(): Buffer {
    if (!this._backend.getBytes) {
      throw new Error('getBytes() is not supported for file-backed streams');
    }
    return this._backend.getBytes();
  }

  /** Seek to position 0 (allows re-reading after a write pass). */
  rewind(): void {
    this._backend.seek(0, 0);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    getLib().c2pa_release_stream(this.ptr);
    for (const cb of this._cbs) koffi.unregister(cb);
    this._backend.close();
  }
}
