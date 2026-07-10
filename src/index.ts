// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

export { loadLibrary } from './lib.js';
export {
  C2paError,
  ManifestNotFoundError,
  VerifyError,
  IoError,
  EncodingError,
  NotSupportedError,
  OperationCancelledError,
  BadParamError,
  NoSigningCredentialError,
} from './error.js';

export {
  Settings,
  ContextBuilder,
  Context,
  ProgressPhase,
  type ProgressCallback,
} from './context.js';

export {
  Signer,
  ed25519Sign,
  type SignerInfo,
  type SigningAlg,
} from './signer.js';

export { Reader } from './reader.js';

export {
  Builder,
  formatEmbeddable,
  HashType,
  type BuilderIntent,
  type DigitalSourceType,
} from './builder.js';

export {
  type SourceAsset,
  type DestinationAsset,
  type FileAsset,
  type FileHandleAsset,
  type DestinationBufferAsset,
} from './stream.js';

// ── Convenience functions ────────────────────────────────────────────────────

import { decodeAndFree, getLib } from './lib.js';
import { C2paError, ManifestNotFoundError } from './error.js';
import { Context, ContextBuilder } from './context.js';
import { Reader } from './reader.js';
import { Builder } from './builder.js';
import { Signer } from './signer.js';
import type { SourceAsset, DestinationAsset } from './stream.js';

/** Return the version string of the loaded C2PA library. */
export function version(): string {
  const ptr = getLib().c2pa_version();
  return decodeAndFree(ptr);
}

/**
 * Read and verify a C2PA manifest from an asset buffer.
 * Returns the parsed manifest store, or null if none is present.
 *
 * ```ts
 * const manifest = read('image/jpeg', jpegBuffer);
 * if (manifest) console.log(manifest.active_manifest);
 * ```
 */
export function read(mimeType: string, asset: SourceAsset): Record<string, unknown> | null {
  const ctx = Context.default();
  const reader = new Reader(ctx);
  try {
    reader.read(mimeType, asset);
    return JSON.parse(reader.json()) as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ManifestNotFoundError) return null;
    throw e;
  } finally {
    reader.dispose();
    ctx.dispose();
  }
}

/**
 * Sign an asset with a manifest definition. The signed asset is written to
 * `dest` — a file path, an open file handle, or `{ buffer: null }`
 * (populated in place with the signed bytes for the common in-memory case).
 * Returns the raw manifest bytes (see Builder.sign()).
 *
 * `signer` is consumed (ownership transfers to an internal Context) — do not
 * reuse or dispose it afterward. Construct a fresh Signer per call if you're
 * signing multiple assets with the same credentials.
 *
 * ```ts
 * const dest = { buffer: null };
 * const manifestBytes = sign('image/jpeg', jpegBuffer, manifestJson, signer, dest);
 * const signedAsset = dest.buffer;
 * ```
 */
export function sign(
  mimeType: string,
  asset: SourceAsset,
  manifestJson: string,
  signer: Signer,
  dest: DestinationAsset,
): Buffer {
  const ctx = new ContextBuilder().withSigner(signer).build();
  const builder = new Builder(ctx);
  try {
    builder.setDefinition(manifestJson);
    return builder.sign(mimeType, asset, dest);
  } finally {
    builder.dispose();
    ctx.dispose();
  }
}
