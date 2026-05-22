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

// ── Convenience functions ────────────────────────────────────────────────────

import { decodeAndFree, getLib } from './lib.js';
import { C2paError, ManifestNotFoundError } from './error.js';
import { Context } from './context.js';
import { Reader } from './reader.js';
import { Builder } from './builder.js';
import { Signer } from './signer.js';

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
export function read(mimeType: string, asset: Buffer): Record<string, unknown> | null {
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
 * Sign an asset with a manifest definition and return the signed bytes.
 *
 * ```ts
 * const signed = sign('image/jpeg', jpegBuffer, manifestJson, signer);
 * ```
 */
export function sign(
  mimeType: string,
  asset: Buffer,
  manifestJson: string,
  signer: Signer,
): Buffer {
  const ctx = Context.default();
  const builder = new Builder(ctx);
  try {
    builder.setDefinition(manifestJson);
    return builder.sign(mimeType, asset, signer);
  } finally {
    builder.dispose();
    ctx.dispose();
  }
}
