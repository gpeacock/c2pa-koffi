// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi, { IKoffiRegisteredCallback } from 'koffi';
import {
  getLib,
  ReadCallbackProto,
  SeekCallbackProto,
  WriteCallbackProto,
  FlushCallbackProto,
  toNum,
} from './lib.js';
import { checkPtr } from './error.js';

/**
 * Buffer-backed seekable stream bridged to the C2PA C API via koffi callbacks.
 *
 * Supports both reading (supply a Buffer) and writing (no initial data).
 * The same instance handles read+write+seek, which is required for the
 * sign destination stream (c2pa may seek back to patch the manifest slot).
 *
 * This is an internal type — users work with plain Buffers.
 */
export class C2paStream {
  // Native C2paStream* — passed directly to C API functions.
  readonly ptr: unknown;

  private _buf: Buffer;
  private _pos = 0;
  private _size: number; // valid bytes written so far (for write streams)
  private _disposed = false;

  // Koffi callback handles — must stay alive as long as the native stream exists.
  private readonly _cbs: IKoffiRegisteredCallback[];

  private constructor(buf: Buffer, size: number) {
    this._buf = buf;
    this._size = size;

    // koffi.register() requires koffi.pointer(proto) as the second argument
    const readCb = koffi.register(
      (_ctx: unknown, outPtr: unknown, len: number | bigint): number => {
        const n = toNum(len);
        const available = Math.min(n, this._size - this._pos);
        if (available <= 0) return 0;
        koffi.encode(outPtr, 'uint8_t', this._buf.subarray(this._pos, this._pos + available), available);
        this._pos += available;
        return available;
      },
      koffi.pointer(ReadCallbackProto),
    );

    const seekCb = koffi.register(
      (_ctx: unknown, offset: number | bigint, mode: number): number => {
        const off = toNum(offset);
        let newPos: number;
        switch (mode) {
          case 0: newPos = off; break;               // Start
          case 1: newPos = this._pos + off; break;   // Current
          case 2: newPos = this._size + off; break;  // End
          default: return -1;
        }
        if (newPos < 0) return -1;
        this._pos = newPos;
        return this._pos;
      },
      koffi.pointer(SeekCallbackProto),
    );

    const writeCb = koffi.register(
      (_ctx: unknown, inPtr: unknown, len: number | bigint): number => {
        const n = toNum(len);
        const end = this._pos + n;
        this._ensureCapacity(end);
        const arr = koffi.decode(inPtr, 'uint8_t', n) as Uint8Array;
        Buffer.from(arr).copy(this._buf, this._pos);
        this._pos += n;
        if (this._pos > this._size) this._size = this._pos;
        return n;
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

  /** Create a read-only stream over an existing Buffer. */
  static fromBuffer(data: Buffer): C2paStream {
    return new C2paStream(Buffer.from(data), data.length);
  }

  /** Create a writable (also seekable/readable) stream with an initial capacity. */
  static writable(initialCapacity = 4 * 1024 * 1024): C2paStream {
    return new C2paStream(Buffer.alloc(initialCapacity), 0);
  }

  /** Return a copy of the bytes written so far. */
  getBytes(): Buffer {
    return Buffer.from(this._buf.subarray(0, this._size));
  }

  /** Seek to position 0 (allows re-reading after a write pass). */
  rewind(): void {
    this._pos = 0;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    getLib().c2pa_release_stream(this.ptr);
    for (const cb of this._cbs) koffi.unregister(cb);
  }

  private _ensureCapacity(needed: number): void {
    if (needed <= this._buf.length) return;
    const newBuf = Buffer.alloc(Math.max(needed, this._buf.length * 2));
    this._buf.copy(newBuf, 0, 0, this._size);
    this._buf = newBuf;
  }
}
