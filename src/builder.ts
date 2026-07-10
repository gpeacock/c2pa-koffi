// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi from 'koffi';
import { getLib, decodeBytesAndFree, toNum, callAsync } from './lib.js';
import { checkPtr, checkInt, checkPtrAsync, checkIntAsync } from './error.js';
import { C2paStream, type SourceAsset, type DestinationAsset } from './stream.js';
import { Context } from './context.js';

import { BuilderIntentValues, DigitalSourceTypeValues } from './lib.js';

export type BuilderIntent      = keyof typeof BuilderIntentValues;
export type DigitalSourceType  = keyof typeof DigitalSourceTypeValues;

/** Hash binding type returned by hashType(). */
export enum HashType {
  DataHash = 0,
  BmffHash = 1,
  BoxHash  = 2,
}

/**
 * Builds and signs C2PA manifests.
 *
 * Signing always uses the signer attached to the Context — either set
 * explicitly via `ContextBuilder.withSigner()`, or derived from a `signer`
 * section in `Settings`. There is no per-call signer argument.
 *
 * Typical usage:
 * ```ts
 * const ctx = new ContextBuilder().withSigner(signer).build();
 * const builder = new Builder(ctx);
 * builder.setDefinition(JSON.stringify({ title: 'My Asset' }));
 * const dest = { buffer: null };
 * const manifestBytes = builder.sign('image/jpeg', sourceBuffer, dest);
 * const signedAsset = dest.buffer;
 * ctx.dispose();
 * builder.dispose();
 * ```
 */
export class Builder {
  private _ptr: unknown;
  private _ctx: Context; // keep context alive
  private _disposed = false;

  constructor(ctx: Context) {
    this._ctx = ctx;
    this._ptr = checkPtr(
      getLib().c2pa_builder_from_context(ctx.ptr),
      'Failed to create C2paBuilder',
    );
  }

  // ── Manifest configuration ──────────────────────────────────────────────

  /** Set the manifest definition from a JSON string. Consumes and replaces the current builder. */
  setDefinition(manifestJson: string): this {
    this._ptr = checkPtr(
      getLib().c2pa_builder_with_definition(this._ptr, manifestJson),
      'Failed to set manifest definition',
    );
    return this;
  }

  /**
   * Set the builder intent.
   * - `Create`: new digital creation, no parent ingredient required.
   * - `Edit`:   editing an existing asset, parent ingredient required.
   * - `Update`: non-editorial change, very restricted.
   *
   * `digitalSourceType` is required for `Create`; ignored for `Edit` / `Update`.
   */
  setIntent(intent: BuilderIntent, digitalSourceType: DigitalSourceType = 'Empty'): this {
    checkInt(getLib().c2pa_builder_set_intent(
      this._ptr,
      BuilderIntentValues[intent],
      DigitalSourceTypeValues[digitalSourceType],
    ));
    return this;
  }

  /** When set the manifest will not be embedded into the signed asset. */
  setNoEmbed(): this {
    getLib().c2pa_builder_set_no_embed(this._ptr);
    return this;
  }

  /** Embed a remote manifest URL into the asset. */
  setRemoteUrl(url: string): this {
    checkInt(getLib().c2pa_builder_set_remote_url(this._ptr, url));
    return this;
  }

  // ── Ingredients & resources ─────────────────────────────────────────────

  /**
   * Add an ingredient from an asset buffer.
   * @param ingredientJson - JSON definition of the ingredient.
   * @param mimeType       - MIME type of the asset.
   * @param asset          - Asset bytes.
   */
  addIngredient(ingredientJson: string, mimeType: string, asset: SourceAsset): this {
    const stream = C2paStream.fromSource(asset);
    try {
      checkInt(
        getLib().c2pa_builder_add_ingredient_from_stream(
          this._ptr, ingredientJson, mimeType, stream.ptr,
        ),
        'Failed to add ingredient',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Async version of addIngredient(). Throws a generic error on failure (see Reader.readAsync()). */
  async addIngredientAsync(ingredientJson: string, mimeType: string, asset: SourceAsset): Promise<this> {
    const stream = C2paStream.fromSource(asset);
    try {
      checkIntAsync(
        await callAsync<number | bigint>(
          getLib().c2pa_builder_add_ingredient_from_stream, this._ptr, ingredientJson, mimeType, stream.ptr,
        ),
        'Failed to add ingredient',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Add a resource (e.g. a custom thumbnail) identified by `uri`. */
  addResource(uri: string, data: SourceAsset): this {
    const stream = C2paStream.fromSource(data);
    try {
      checkInt(
        getLib().c2pa_builder_add_resource(this._ptr, uri, stream.ptr),
        `Failed to add resource: ${uri}`,
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Async version of addResource(). Throws a generic error on failure (see Reader.readAsync()). */
  async addResourceAsync(uri: string, data: SourceAsset): Promise<this> {
    const stream = C2paStream.fromSource(data);
    try {
      checkIntAsync(
        await callAsync<number | bigint>(getLib().c2pa_builder_add_resource, this._ptr, uri, stream.ptr),
        `Failed to add resource: ${uri}`,
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Add a JSON-defined action to the manifest. */
  addAction(actionJson: string): this {
    checkInt(getLib().c2pa_builder_add_action(this._ptr, actionJson));
    return this;
  }

  /** Add an ingredient from a previously written ingredient archive. */
  addIngredientFromArchive(archive: SourceAsset): this {
    const stream = C2paStream.fromSource(archive);
    try {
      checkInt(
        getLib().c2pa_builder_add_ingredient_from_archive(this._ptr, stream.ptr),
        'Failed to add ingredient from archive',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Async version of addIngredientFromArchive(). Throws a generic error on failure (see Reader.readAsync()). */
  async addIngredientFromArchiveAsync(archive: SourceAsset): Promise<this> {
    const stream = C2paStream.fromSource(archive);
    try {
      checkIntAsync(
        await callAsync<number | bigint>(getLib().c2pa_builder_add_ingredient_from_archive, this._ptr, stream.ptr),
        'Failed to add ingredient from archive',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  // ── Signing ─────────────────────────────────────────────────────────────

  /**
   * Sign an asset using the signer attached to the Context (set explicitly
   * via `ContextBuilder.withSigner()`, or derived from a `signer` section in
   * `Settings`). The signed asset is written to `dest` — a file path, an
   * open file handle, or `{ buffer: null }` (populated with the signed
   * bytes in place, for the common in-memory case).
   *
   * Returns the raw manifest bytes, needed for remote-manifest/no-embed/
   * sidecar workflows even when the asset itself was embedded.
   */
  sign(mimeType: string, source: SourceAsset, dest: DestinationAsset): Buffer {
    const srcStream  = C2paStream.fromSource(source);
    const destStream = C2paStream.forDestination(dest);
    const manifestBytesOut: unknown[] = [null];
    try {
      const size = checkInt(
        getLib().c2pa_builder_sign_context(
          this._ptr, mimeType, srcStream.ptr, destStream.ptr, manifestBytesOut,
        ),
        'Signing failed',
      );
      C2paStream.finalizeDestination(dest, destStream);
      return decodeBytesAndFree(manifestBytesOut[0], size);
    } finally {
      srcStream.dispose();
      destStream.dispose();
    }
  }

  /**
   * Async version of sign(). Runs the native call via koffi's built-in
   * `.async()` dispatch instead of blocking the event loop — this is the
   * one to use for large (e.g. multi-GB) assets combined with file-backed
   * source/dest assets.
   *
   * Note: on failure this throws a generic C2paError, not the detailed
   * "Type: reason" message the sync API provides — see Reader.readAsync().
   */
  async signAsync(mimeType: string, source: SourceAsset, dest: DestinationAsset): Promise<Buffer> {
    const srcStream  = C2paStream.fromSource(source);
    const destStream = C2paStream.forDestination(dest);
    const manifestBytesOut: unknown[] = [null];
    try {
      const size = checkIntAsync(
        await callAsync<number | bigint>(
          getLib().c2pa_builder_sign_context,
          this._ptr, mimeType, srcStream.ptr, destStream.ptr, manifestBytesOut,
        ),
        'Signing failed',
      );
      C2paStream.finalizeDestination(dest, destStream);
      return decodeBytesAndFree(manifestBytesOut[0], size);
    } finally {
      srcStream.dispose();
      destStream.dispose();
    }
  }

  // ── Embeddable / two-pass workflows ─────────────────────────────────────

  /**
   * Returns true if the format requires a placeholder to be embedded
   * before computing the asset hash.
   */
  needsPlaceholder(mimeType: string): boolean {
    const result = getLib().c2pa_builder_needs_placeholder(this._ptr, mimeType) as number;
    if (result < 0) return false;
    return result === 1;
  }

  /** Returns the hash binding type that will be used for this format. */
  hashType(mimeType: string): HashType {
    const out = [0];
    checkInt(getLib().c2pa_builder_hash_type(this._ptr, mimeType, out));
    return out[0] as HashType;
  }

  /**
   * Generate a placeholder manifest for embedding into the asset.
   * Use this for two-pass workflows (embed placeholder → hash asset → sign).
   * Returns the raw placeholder bytes.
   */
  placeholder(mimeType: string): Buffer {
    const ptrOut: unknown[] = [null];
    const size = toNum(getLib().c2pa_builder_placeholder(this._ptr, mimeType, ptrOut) as number | bigint);
    checkInt(size, 'Failed to generate placeholder');
    return decodeBytesAndFree(ptrOut[0], size);
  }

  /**
   * Sign and return the embeddable manifest bytes.
   * Call after placeholder() + asset hashing.
   * The returned bytes are the same size as the placeholder (safe for in-place patching).
   */
  signEmbeddable(mimeType: string): Buffer {
    const ptrOut: unknown[] = [null];
    const size = toNum(getLib().c2pa_builder_sign_embeddable(this._ptr, mimeType, ptrOut) as number | bigint);
    checkInt(size, 'Embeddable signing failed');
    return decodeBytesAndFree(ptrOut[0], size);
  }

  /**
   * Set DataHash exclusion ranges (byte regions occupied by the placeholder).
   * `exclusions` is an array of [start, length] pairs.
   */
  setDataHashExclusions(exclusions: [number, number][]): this {
    // Pack [start, length] pairs into a flat uint64 array
    const flat = new BigUint64Array(exclusions.length * 2);
    for (let i = 0; i < exclusions.length; i++) {
      flat[i * 2]     = BigInt(exclusions[i][0]);
      flat[i * 2 + 1] = BigInt(exclusions[i][1]);
    }
    const buf = Buffer.from(flat.buffer);
    checkInt(
      getLib().c2pa_builder_set_data_hash_exclusions(this._ptr, buf, exclusions.length),
      'Failed to set data hash exclusions',
    );
    return this;
  }

  /** Hash the asset stream and update the hard binding assertion. */
  updateHashFromStream(mimeType: string, asset: SourceAsset): this {
    const stream = C2paStream.fromSource(asset);
    try {
      checkInt(
        getLib().c2pa_builder_update_hash_from_stream(this._ptr, mimeType, stream.ptr),
        'Failed to update hash from stream',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Async version of updateHashFromStream(). Throws a generic error on failure (see Reader.readAsync()). */
  async updateHashFromStreamAsync(mimeType: string, asset: SourceAsset): Promise<this> {
    const stream = C2paStream.fromSource(asset);
    try {
      checkIntAsync(
        await callAsync<number | bigint>(getLib().c2pa_builder_update_hash_from_stream, this._ptr, mimeType, stream.ptr),
        'Failed to update hash from stream',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  // ── Archive workflows ────────────────────────────────────────────────────

  /** Serialize the builder state to an archive. Pass `dest` to write straight to a file instead of returning a Buffer. */
  toArchive(dest?: DestinationAsset): Buffer | undefined {
    const out = C2paStream.forDestination(dest);
    try {
      checkInt(getLib().c2pa_builder_to_archive(this._ptr, out.ptr), 'Failed to write archive');
      return dest === undefined ? out.getBytes() : undefined;
    } finally {
      out.dispose();
    }
  }

  /** Async version of toArchive(). Throws a generic error on failure (see Reader.readAsync()). */
  async toArchiveAsync(dest?: DestinationAsset): Promise<Buffer | undefined> {
    const out = C2paStream.forDestination(dest);
    try {
      checkIntAsync(
        await callAsync<number | bigint>(getLib().c2pa_builder_to_archive, this._ptr, out.ptr),
        'Failed to write archive',
      );
      return dest === undefined ? out.getBytes() : undefined;
    } finally {
      out.dispose();
    }
  }

  /** Restore a Builder from an archive (replaces current state). */
  withArchive(archive: SourceAsset): this {
    const stream = C2paStream.fromSource(archive);
    try {
      this._ptr = checkPtr(
        getLib().c2pa_builder_with_archive(this._ptr, stream.ptr),
        'Failed to restore from archive',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Async version of withArchive(). Throws a generic error on failure (see Reader.readAsync()). */
  async withArchiveAsync(archive: SourceAsset): Promise<this> {
    const stream = C2paStream.fromSource(archive);
    try {
      this._ptr = checkPtrAsync(
        await callAsync<unknown>(getLib().c2pa_builder_with_archive, this._ptr, stream.ptr),
        'Failed to restore from archive',
      );
    } finally {
      stream.dispose();
    }
    return this;
  }

  /** Write a single-ingredient archive for a previously added ingredient. Pass `dest` to write straight to a file. */
  writeIngredientArchive(ingredientId: string, dest?: DestinationAsset): Buffer | undefined {
    const out = C2paStream.forDestination(dest);
    try {
      checkInt(
        getLib().c2pa_builder_write_ingredient_archive(this._ptr, ingredientId, out.ptr),
        'Failed to write ingredient archive',
      );
      return dest === undefined ? out.getBytes() : undefined;
    } finally {
      out.dispose();
    }
  }

  /** Async version of writeIngredientArchive(). Throws a generic error on failure (see Reader.readAsync()). */
  async writeIngredientArchiveAsync(ingredientId: string, dest?: DestinationAsset): Promise<Buffer | undefined> {
    const out = C2paStream.forDestination(dest);
    try {
      checkIntAsync(
        await callAsync<number | bigint>(getLib().c2pa_builder_write_ingredient_archive, this._ptr, ingredientId, out.ptr),
        'Failed to write ingredient archive',
      );
      return dest === undefined ? out.getBytes() : undefined;
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

/**
 * Convert a raw c2pa manifest buffer into an embeddable format-specific wrapper.
 * Useful for taking a cloud manifest and embedding it into a local asset.
 */
export function formatEmbeddable(mimeType: string, manifestBytes: Buffer): Buffer {
  const ptrOut: unknown[] = [null];
  const size = toNum(
    getLib().c2pa_format_embeddable(
      mimeType, manifestBytes, manifestBytes.length, ptrOut,
    ) as number | bigint,
  );
  checkInt(size, 'formatEmbeddable failed');
  return decodeBytesAndFree(ptrOut[0], size);
}
