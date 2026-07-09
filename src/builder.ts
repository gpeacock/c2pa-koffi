// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi from 'koffi';
import { getLib, decodeBytesAndFree, toNum } from './lib.js';
import { checkPtr, checkInt } from './error.js';
import { C2paStream } from './stream.js';
import { Context } from './context.js';
import { Signer } from './signer.js';

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
 * Typical usage:
 * ```ts
 * const ctx = Context.default();
 * const builder = new Builder(ctx);
 * builder.setDefinition(JSON.stringify({ title: 'My Asset' }));
 * const signed = builder.sign('image/jpeg', sourceBuffer, signer);
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
  addIngredient(ingredientJson: string, mimeType: string, asset: Buffer): this {
    const stream = C2paStream.fromBuffer(asset);
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

  /** Add a resource (e.g. a custom thumbnail) identified by `uri`. */
  addResource(uri: string, data: Buffer): this {
    const stream = C2paStream.fromBuffer(data);
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

  /** Add a JSON-defined action to the manifest. */
  addAction(actionJson: string): this {
    checkInt(getLib().c2pa_builder_add_action(this._ptr, actionJson));
    return this;
  }

  /** Add an ingredient from a previously written ingredient archive. */
  addIngredientFromArchive(archive: Buffer): this {
    const stream = C2paStream.fromBuffer(archive);
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

  // ── Signing ─────────────────────────────────────────────────────────────

  /**
   * Sign an asset and return the signed bytes.
   * This is the standard single-step sign workflow.
   */
  sign(mimeType: string, source: Buffer, signer: Signer): Buffer {
    const srcStream  = C2paStream.fromBuffer(source);
    const destStream = C2paStream.writable();
    const manifestBytesOut: unknown[] = [null];
    try {
      checkInt(
        getLib().c2pa_builder_sign(
          this._ptr, mimeType, srcStream.ptr, destStream.ptr, signer.ptr, manifestBytesOut,
        ),
        'Signing failed',
      );
      return destStream.getBytes();
    } finally {
      if (manifestBytesOut[0]) getLib().c2pa_free(manifestBytesOut[0]);
      srcStream.dispose();
      destStream.dispose();
    }
  }

  /**
   * Sign using the signer baked into the Context.
   * The context must have been built with ContextBuilder.withSigner().
   */
  signWithContext(mimeType: string, source: Buffer): Buffer {
    const srcStream  = C2paStream.fromBuffer(source);
    const destStream = C2paStream.writable();
    const manifestBytesOut: unknown[] = [null];
    try {
      checkInt(
        getLib().c2pa_builder_sign_context(
          this._ptr, mimeType, srcStream.ptr, destStream.ptr, manifestBytesOut,
        ),
        'Signing failed',
      );
      return destStream.getBytes();
    } finally {
      if (manifestBytesOut[0]) getLib().c2pa_free(manifestBytesOut[0]);
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
  updateHashFromStream(mimeType: string, asset: Buffer): this {
    const stream = C2paStream.fromBuffer(asset);
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

  // ── Archive workflows ────────────────────────────────────────────────────

  /** Serialize the builder state to an archive buffer for later restoration. */
  toArchive(): Buffer {
    const out = C2paStream.writable();
    try {
      checkInt(getLib().c2pa_builder_to_archive(this._ptr, out.ptr), 'Failed to write archive');
      return out.getBytes();
    } finally {
      out.dispose();
    }
  }

  /** Restore a Builder from an archive buffer (replaces current state). */
  withArchive(archive: Buffer): this {
    const stream = C2paStream.fromBuffer(archive);
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

  /** Write a single-ingredient archive for a previously added ingredient. */
  writeIngredientArchive(ingredientId: string): Buffer {
    const out = C2paStream.writable();
    try {
      checkInt(
        getLib().c2pa_builder_write_ingredient_archive(this._ptr, ingredientId, out.ptr),
        'Failed to write ingredient archive',
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
