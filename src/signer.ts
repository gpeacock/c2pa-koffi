// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi, { IKoffiRegisteredCallback } from 'koffi';
import { getLib, SignerCallbackProto, SignerInfoType, SigningAlgValues, toNum } from './lib.js';
import { checkPtr, checkInt } from './error.js';

export type SigningAlg = keyof typeof SigningAlgValues;

export interface SignerInfo {
  /** Signing algorithm, e.g. "es256". */
  alg: SigningAlg;
  /** PEM-encoded certificate chain. */
  signCert: string;
  /** PEM-encoded private key. */
  privateKey: string;
  /** Optional RFC 3161 timestamp authority URL. */
  taUrl?: string;
}

/**
 * Wraps a C2paSigner. Owns the native pointer.
 *
 * Create with Signer.fromInfo() or Signer.fromCallback().
 * If you pass a Signer to ContextBuilder.withSigner(), ownership transfers
 * to the context — do not call dispose() afterward.
 */
export class Signer {
  /** @internal */ ptr: unknown;
  private _disposed = false;
  // Keep the JS callback alive as long as this signer exists.
  private _cb: IKoffiRegisteredCallback | null = null;

  /** @internal */
  private constructor(ptr: unknown) {
    this.ptr = ptr;
  }

  /**
   * Create a signer from PEM credentials.
   * The private key never leaves the process.
   */
  static fromInfo(info: SignerInfo): Signer {
    const struct = {
      alg:         info.alg.toLowerCase(),
      sign_cert:   info.signCert,
      private_key: info.privateKey,
      ta_url:      info.taUrl ?? null,
    };
    const ptr = checkPtr(
      getLib().c2pa_signer_from_info(struct),
      'Failed to create signer from info',
    );
    return new Signer(ptr);
  }

  /**
   * Create a signer backed by a JS callback.
   *
   * The callback receives the raw bytes to sign and must return the DER-encoded
   * signature synchronously. Throw on failure; the error will be converted to
   * a C2PA error return.
   *
   * @param sign - `(data: Buffer) => Buffer`
   * @param alg  - Signing algorithm
   * @param certs - PEM certificate chain
   * @param taUrl - Optional timestamp authority URL
   */
  static fromCallback(
    sign: (data: Buffer) => Buffer,
    alg: SigningAlg,
    certs: string,
    taUrl?: string,
  ): Signer {
    const MAX_DATA = 1024 * 1024; // 1 MB safety limit

    const wrapped = koffi.register(
      (
        _ctx: unknown,
        dataPtr: unknown,
        len: number | bigint,
        outPtr: unknown,
        outLen: number | bigint,
      ): number => {
        try {
          const n = toNum(len);
          const maxOut = toNum(outLen);
          if (n <= 0 || n > MAX_DATA || maxOut <= 0) return -1;

          const arr = koffi.decode(dataPtr, 'uint8_t', n) as number[];
          const signature = sign(Buffer.from(arr));

          const actual = Math.min(signature.length, maxOut);
          koffi.encode(outPtr, 'uint8_t', signature.subarray(0, actual), actual);
          return actual;
        } catch {
          return -1;
        }
      },
      koffi.pointer(SignerCallbackProto),
    );

    const ptr = checkPtr(
      getLib().c2pa_signer_create(null, wrapped, SigningAlgValues[alg], certs, taUrl ?? null),
      'Failed to create callback signer',
    );

    const s = new Signer(ptr);
    s._cb = wrapped;
    return s;
  }

  /**
   * Create a combined C2PA + X.509 identity signer.
   * Both `c2paSigner` and `identitySigner` are consumed — do not use them afterward.
   */
  static withIdentity(
    c2paSigner: Signer,
    identitySigner: Signer,
    referencedAssertions?: string[],
    roles?: string[],
  ): Signer {
    const createIdentity = getLib().c2pa_identity_signer_create;
    if (!createIdentity) {
      throw new Error('Identity signer is not supported by the loaded c2pa library version');
    }

    // Build null-terminated C string arrays via koffi encode
    // Pass null when arrays are empty/absent (C API accepts NULL)
    const refsPtr  = referencedAssertions?.length ? buildNullTerminatedArray(referencedAssertions) : null;
    const rolesPtr = roles?.length               ? buildNullTerminatedArray(roles)                : null;

    const ptr = checkPtr(
      createIdentity(c2paSigner.ptr, identitySigner.ptr, refsPtr, rolesPtr),
      'Failed to create identity signer',
    );

    // Both input signers are consumed; null their pointers to prevent double-free.
    c2paSigner.ptr = null;
    c2paSigner._disposed = true;
    identitySigner.ptr = null;
    identitySigner._disposed = true;

    return new Signer(ptr);
  }

  /** Return the number of bytes the signer needs reserved for its signature. */
  reserveSize(): number {
    return checkInt(getLib().c2pa_signer_reserve_size(this.ptr));
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    if (this.ptr) getLib().c2pa_free(this.ptr);
    if (this._cb) koffi.unregister(this._cb);
  }
}

/** Sign bytes with an Ed25519 private key. Returns the DER signature. */
export function ed25519Sign(data: Buffer, privateKeyPem: string): Buffer {
  const ptr = getLib().c2pa_ed25519_sign(data, data.length, privateKeyPem);
  checkPtr(ptr, 'ed25519 signing failed');
  // ed25519 signatures are always 64 bytes
  const arr = koffi.decode(ptr, 'uint8_t', 64) as number[];
  getLib().c2pa_free(ptr);
  return Buffer.from(arr);
}

// Builds a NULL-terminated array of C strings via a flat Buffer.
// The C API reads the array for the duration of the call, so the Buffer
// just needs to survive until the FFI call returns.
function buildNullTerminatedArray(strings: string[]): Buffer {
  // We encode as a JSON array-of-strings and decode on the C side... except
  // the C API expects a char** (array of char* pointers), which koffi can't
  // trivially construct without manual pointer arithmetic.
  // For now, this is a placeholder — identity signer support requires a
  // koffi helper for constructing pointer arrays, which can be added later.
  void strings;
  throw new Error('buildNullTerminatedArray: not yet implemented — pass null for now');
}
