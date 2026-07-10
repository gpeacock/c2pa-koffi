// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import { getLib, decodeAndFree, callAsync } from './lib.js';
import { checkPtr, checkInt, checkPtrAsync, checkIntAsync } from './error.js';
import { C2paStream } from './stream.js';
import { Context } from './context.js';

/**
 * Reads and verifies C2PA manifests from asset streams.
 *
 * Typical usage:
 * ```ts
 * const ctx = Context.default();
 * const reader = new Reader(ctx);
 * reader.read('image/jpeg', assetBuffer);
 * const manifest = JSON.parse(reader.json());
 * ctx.dispose();
 * reader.dispose();
 * ```
 */
export class Reader {
  private _ptr: unknown;
  private _ctx: Context; // keep context alive
  private _disposed = false;

  constructor(ctx: Context) {
    this._ctx = ctx;
    this._ptr = checkPtr(
      getLib().c2pa_reader_from_context(ctx.ptr),
      'Failed to create C2paReader',
    );
  }

  /**
   * Read and verify the manifest from an asset buffer.
   * Returns `this` for chaining.
   */
  read(mimeType: string, asset: Buffer): this {
    const stream = C2paStream.fromBuffer(asset);
    try {
      const newPtr = checkPtr(
        getLib().c2pa_reader_with_stream(this._ptr, mimeType, stream.ptr),
        `Failed to read ${mimeType} asset`,
      );
      // c2pa_reader_with_stream consumes the old reader pointer and returns a new one
      this._ptr = newPtr;
    } finally {
      stream.dispose();
    }
    return this;
  }

  /**
   * Async version of read(). Runs the native call via koffi's built-in
   * `.async()` dispatch instead of blocking the event loop.
   *
   * Note: on failure this throws a generic C2paError rather than a specific
   * subclass like ManifestNotFoundError — c2pa's last-error state is
   * thread-local and can't be read reliably across the async boundary
   * under concurrency, so only a generic message is available here.
   */
  async readAsync(mimeType: string, asset: Buffer): Promise<this> {
    const stream = C2paStream.fromBuffer(asset);
    try {
      const newPtr = checkPtrAsync(
        await callAsync<unknown>(getLib().c2pa_reader_with_stream, this._ptr, mimeType, stream.ptr),
        `Failed to read ${mimeType} asset`,
      );
      this._ptr = newPtr;
    } finally {
      stream.dispose();
    }
    return this;
  }

  /**
   * Read from an asset buffer with an explicit detached manifest.
   * Used for cloud/sidecar manifest workflows.
   */
  readWithManifest(mimeType: string, asset: Buffer, manifestData: Buffer): this {
    const stream = C2paStream.fromBuffer(asset);
    try {
      const newPtr = checkPtr(
        getLib().c2pa_reader_with_manifest_data_and_stream(
          this._ptr, mimeType, stream.ptr, manifestData, manifestData.length,
        ),
        'Failed to read asset with manifest data',
      );
      this._ptr = newPtr;
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Async version of readWithManifest(). See readAsync() for the error-detail caveat. */
  async readWithManifestAsync(mimeType: string, asset: Buffer, manifestData: Buffer): Promise<this> {
    const stream = C2paStream.fromBuffer(asset);
    try {
      const newPtr = checkPtrAsync(
        await callAsync<unknown>(
          getLib().c2pa_reader_with_manifest_data_and_stream,
          this._ptr, mimeType, stream.ptr, manifestData, manifestData.length,
        ),
        'Failed to read asset with manifest data',
      );
      this._ptr = newPtr;
    } finally {
      stream.dispose();
    }
    return this;
  }

  /**
   * Read a fragmented BMFF asset (e.g. a fragmented MP4).
   * `fragment` is the separate fragment stream containing the manifest box.
   */
  readFragment(mimeType: string, asset: Buffer, fragment: Buffer): this {
    const assetStream    = C2paStream.fromBuffer(asset);
    const fragmentStream = C2paStream.fromBuffer(fragment);
    try {
      const newPtr = checkPtr(
        getLib().c2pa_reader_with_fragment(
          this._ptr, mimeType, assetStream.ptr, fragmentStream.ptr,
        ),
        'Failed to read fragmented asset',
      );
      this._ptr = newPtr;
    } finally {
      assetStream.dispose();
      fragmentStream.dispose();
    }
    return this;
  }

  /** Async version of readFragment(). See readAsync() for the error-detail caveat. */
  async readFragmentAsync(mimeType: string, asset: Buffer, fragment: Buffer): Promise<this> {
    const assetStream    = C2paStream.fromBuffer(asset);
    const fragmentStream = C2paStream.fromBuffer(fragment);
    try {
      const newPtr = checkPtrAsync(
        await callAsync<unknown>(
          getLib().c2pa_reader_with_fragment,
          this._ptr, mimeType, assetStream.ptr, fragmentStream.ptr,
        ),
        'Failed to read fragmented asset',
      );
      this._ptr = newPtr;
    } finally {
      assetStream.dispose();
      fragmentStream.dispose();
    }
    return this;
  }

  /** Returns the manifest store as a JSON string. */
  json(): string {
    const ptr = checkPtr(getLib().c2pa_reader_json(this._ptr), 'Failed to get manifest JSON');
    return decodeAndFree(ptr);
  }

  /** Returns a detailed manifest store JSON string (includes validation status). */
  detailedJson(): string {
    const ptr = checkPtr(getLib().c2pa_reader_detailed_json(this._ptr), 'Failed to get detailed JSON');
    return decodeAndFree(ptr);
  }

  /**
   * If the manifest was fetched from a remote URL, returns that URL.
   * The string is owned by the reader — do not free it.
   */
  remoteUrl(): string | null {
    return getLib().c2pa_reader_remote_url(this._ptr) as string | null;
  }

  /** Returns true if the manifest was embedded in the asset. */
  isEmbedded(): boolean {
    return getLib().c2pa_reader_is_embedded(this._ptr) as boolean;
  }

  /**
   * Write a named resource (e.g. a thumbnail) to the returned Buffer.
   * `uri` must match an identifier in the manifest store.
   */
  getResource(uri: string): Buffer {
    const out = C2paStream.writable();
    try {
      checkInt(
        getLib().c2pa_reader_resource_to_stream(this._ptr, uri, out.ptr),
        `Failed to get resource: ${uri}`,
      );
      return out.getBytes();
    } finally {
      out.dispose();
    }
  }

  /** Async version of getResource(). Throws a generic error on failure (see readAsync()). */
  async getResourceAsync(uri: string): Promise<Buffer> {
    const out = C2paStream.writable();
    try {
      checkIntAsync(
        await callAsync<number | bigint>(getLib().c2pa_reader_resource_to_stream, this._ptr, uri, out.ptr),
        `Failed to get resource: ${uri}`,
      );
      return out.getBytes();
    } finally {
      out.dispose();
    }
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    getLib().c2pa_free(this._ptr);
  }
}
