// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import { decodeAndFree, getLib } from './lib.js';

/**
 * Base error thrown by all C2PA operations.
 * The `type` property holds the error kind from the Rust library
 * (e.g. "ManifestNotFound", "Verify", "Io").
 */
export class C2paError extends Error {
  readonly type: string;

  constructor(message: string, type = 'Other') {
    super(message);
    this.name = 'C2paError';
    this.type = type;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ManifestNotFoundError extends C2paError {
  constructor(msg: string) { super(msg, 'ManifestNotFound'); this.name = 'ManifestNotFoundError'; }
}
export class VerifyError extends C2paError {
  constructor(msg: string) { super(msg, 'Verify'); this.name = 'VerifyError'; }
}
export class IoError extends C2paError {
  constructor(msg: string) { super(msg, 'Io'); this.name = 'IoError'; }
}
export class EncodingError extends C2paError {
  constructor(msg: string) { super(msg, 'Encoding'); this.name = 'EncodingError'; }
}
export class NotSupportedError extends C2paError {
  constructor(msg: string) { super(msg, 'NotSupported'); this.name = 'NotSupportedError'; }
}
export class OperationCancelledError extends C2paError {
  constructor(msg: string) { super(msg, 'OperationCancelled'); this.name = 'OperationCancelledError'; }
}
export class BadParamError extends C2paError {
  constructor(msg: string) { super(msg, 'BadParam'); this.name = 'BadParamError'; }
}
export class NoSigningCredentialError extends C2paError {
  constructor(msg: string) { super(msg, 'NoSigningCredential'); this.name = 'NoSigningCredentialError'; }
}

/** Retrieve the last C2PA error from Rust and throw it. */
export function throwLastError(fallback = 'Unknown C2PA error'): never {
  const ptr = getLib().c2pa_error();
  const msg = ptr ? decodeAndFree(ptr) : fallback;
  throw parseError(msg);
}

/** Parse "ErrorType: message" format returned by the C library. */
export function parseError(raw: string): C2paError {
  const sep = raw.indexOf(': ');
  const type = sep >= 0 ? raw.slice(0, sep) : 'Other';
  switch (type) {
    case 'ManifestNotFound':    return new ManifestNotFoundError(raw);
    case 'Verify':              return new VerifyError(raw);
    case 'Io':                  return new IoError(raw);
    case 'Encoding':            return new EncodingError(raw);
    case 'NotSupported':        return new NotSupportedError(raw);
    case 'OperationCancelled':  return new OperationCancelledError(raw);
    case 'BadParam':            return new BadParamError(raw);
    case 'NoSigningCredential': return new NoSigningCredentialError(raw);
    default:                    return new C2paError(raw, type);
  }
}

/** Check integer return value; throw last error if negative. */
export function checkInt(result: number | bigint, fallback?: string): number {
  const n = typeof result === 'bigint' ? Number(result) : result;
  if (n < 0) throwLastError(fallback);
  return n;
}

/** Check pointer return value; throw last error if null/falsy. */
export function checkPtr<T>(ptr: T | null | undefined | false | 0, fallback?: string): T {
  if (!ptr) throwLastError(fallback);
  return ptr as T;
}
