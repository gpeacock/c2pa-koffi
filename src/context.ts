// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi, { IKoffiRegisteredCallback } from 'koffi';
import { getLib, ProgressCallbackProto } from './lib.js';
import { checkPtr, checkInt } from './error.js';

/** Progress phase constants, matching the C2paProgressPhase enum. */
export enum ProgressPhase {
  Reading               = 0,
  VerifyingManifest     = 1,
  VerifyingSignature    = 2,
  VerifyingIngredient   = 3,
  VerifyingAssetHash    = 4,
  AddingIngredient      = 5,
  Thumbnail             = 6,
  Hashing               = 7,
  Signing               = 8,
  Embedding             = 9,
  FetchingRemoteManifest= 10,
  Writing               = 11,
  FetchingOCSP          = 12,
  FetchingTimestamp     = 13,
}

/**
 * Called during long operations. Return `false` to request cancellation.
 *
 * - `phase` identifies what the SDK is doing.
 * - `step` is a rising counter within the phase (liveness signal).
 * - `total` is 0 (indeterminate), 1 (single-shot), or >1 (determinate: step/total = fraction).
 */
export type ProgressCallback = (phase: ProgressPhase, step: number, total: number) => boolean;

// ── Settings ────────────────────────────────────────────────────────────────

/**
 * Immutable-once-built configuration for a Context.
 * Create, configure, then pass to ContextBuilder.withSettings().
 */
export class Settings {
  /** @internal */ readonly ptr: unknown;
  private _disposed = false;

  constructor() {
    this.ptr = checkPtr(getLib().c2pa_settings_new(), 'Failed to create C2paSettings');
  }

  /** Update from a JSON or TOML string. */
  updateFromString(content: string, format: 'json' | 'toml' = 'json'): this {
    checkInt(getLib().c2pa_settings_update_from_string(this.ptr, content, format));
    return this;
  }

  /**
   * Set a single value using dot-notation path.
   * The value must be a JSON-encoded scalar (e.g. `"true"`, `'"ps256"'`, `"42"`).
   */
  setValue(path: string, value: string): this {
    checkInt(getLib().c2pa_settings_set_value(this.ptr, path, value));
    return this;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    getLib().c2pa_free(this.ptr);
  }
}

// ── ContextBuilder ──────────────────────────────────────────────────────────

/**
 * Fluent builder for a Context.
 * Call build() once — the builder is consumed and becomes invalid.
 */
export class ContextBuilder {
  private _ptr: unknown;
  private _progressCb: IKoffiRegisteredCallback | null = null;

  constructor() {
    this._ptr = checkPtr(getLib().c2pa_context_builder_new(), 'Failed to create C2paContextBuilder');
  }

  withSettings(settings: Settings): this {
    checkInt(getLib().c2pa_context_builder_set_settings(this._ptr, settings.ptr));
    return this;
  }

  /** Transfer ownership of a Signer to the context. The signer must not be freed after this. */
  withSigner(signer: { ptr: unknown }): this {
    checkInt(getLib().c2pa_context_builder_set_signer(this._ptr, signer.ptr));
    return this;
  }

  withProgressCallback(cb: ProgressCallback): this {
    const wrapped = koffi.register(
      (_ctx: unknown, phase: number, step: number, total: number): number => {
        try { return cb(phase as ProgressPhase, step, total) ? 1 : 0; }
        catch { return 0; }
      },
      koffi.pointer(ProgressCallbackProto),
    );
    this._progressCb = wrapped;
    checkInt(getLib().c2pa_context_builder_set_progress_callback(this._ptr, null, wrapped));
    return this;
  }

  /** Build the context. This consumes the builder — do not call any other method afterward. */
  build(): Context {
    const ctx = checkPtr(
      getLib().c2pa_context_builder_build(this._ptr),
      'Failed to build C2paContext',
    );
    // builder pointer is now invalid; guard against reuse
    this._ptr = null;
    return new Context(ctx, this._progressCb);
  }
}

// ── Context ──────────────────────────────────────────────────────────────────

/**
 * Immutable, shareable configuration object.
 * Pass to Reader and Builder; they hold a reference so the context stays alive.
 */
export class Context {
  /** @internal */ readonly ptr: unknown;
  private _disposed = false;
  // Keep the progress callback alive for the context's lifetime.
  private readonly _progressCb: IKoffiRegisteredCallback | null;

  /** Create a default context (no custom settings, no signer). */
  static default(): Context {
    return new Context(
      checkPtr(getLib().c2pa_context_new(), 'Failed to create C2paContext'),
      null,
    );
  }

  /** @internal */
  constructor(ptr: unknown, progressCb: IKoffiRegisteredCallback | null) {
    this.ptr = ptr;
    this._progressCb = progressCb;
  }

  /** Request cancellation of any in-progress operation on this context. Thread-safe. */
  cancel(): void {
    getLib().c2pa_context_cancel(this.ptr);
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    getLib().c2pa_free(this.ptr);
    if (this._progressCb) koffi.unregister(this._progressCb);
  }
}
