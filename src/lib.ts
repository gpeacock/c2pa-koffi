// Copyright 2025 Adobe. All rights reserved.
// This file is licensed to you under the Apache License, Version 2.0
// or the MIT license, at your option.

import koffi from 'koffi';
import { existsSync } from 'fs';
import { join } from 'path';
import { platform } from 'os';

// ── Opaque types (registered once globally by name) ─────────────────────────
// After registration, use the string 'TypeName *' in lib.func() signatures.

koffi.opaque('C2paStream');
koffi.opaque('C2paReader');
koffi.opaque('C2paBuilder');
koffi.opaque('C2paSigner');
koffi.opaque('C2paContext');
koffi.opaque('C2paSettings');
koffi.opaque('C2paContextBuilder');
koffi.opaque('C2paHttpResolver');

// ── Callback prototypes ──────────────────────────────────────────────────────
// - koffi.proto() registers the type globally; keep the reference for koffi.register().
// - Use the string 'TypeName *' in lib.func() parameter lists.
// - Pass koffi.pointer(proto) as the second arg to koffi.register().

export const ReadCallbackProto    = koffi.proto('intptr_t ReadCallback(void *ctx, uint8_t *data, intptr_t len)');
export const SeekCallbackProto    = koffi.proto('intptr_t SeekCallback(void *ctx, intptr_t offset, int mode)');
export const WriteCallbackProto   = koffi.proto('intptr_t WriteCallback(void *ctx, const uint8_t *data, intptr_t len)');
export const FlushCallbackProto   = koffi.proto('intptr_t FlushCallback(void *ctx)');
export const SignerCallbackProto  = koffi.proto('intptr_t SignerCallback(const void *ctx, const uint8_t *data, uintptr_t len, uint8_t *signed_bytes, uintptr_t signed_len)');
export const ProgressCallbackProto = koffi.proto('int ProgressCallback(const void *ctx, int phase, uint32_t step, uint32_t total)');

// ── SignerInfo struct ────────────────────────────────────────────────────────

export const SignerInfoType = koffi.struct('C2paSignerInfo', {
  alg:         'str',
  sign_cert:   'str',
  private_key: 'str',
  ta_url:      'str',
});

// ── Enum values ──────────────────────────────────────────────────────────────

export const SigningAlgValues = {
  Es256:   0,  Es384:   1,  Es512:   2,
  Ps256:   3,  Ps384:   4,  Ps512:   5,
  Ed25519: 6,
} as const;

export const BuilderIntentValues = {
  Create: 0, Edit: 1, Update: 2,
} as const;

export const DigitalSourceTypeValues = {
  Empty:                               0,  TrainedAlgorithmicData:              1,
  DigitalCapture:                      2,  ComputationalCapture:                3,
  NegativeFilm:                        4,  PositiveFilm:                        5,
  Print:                               6,  HumanEdits:                          7,
  CompositeWithTrainedAlgorithmicMedia:8,  AlgorithmicallyEnhanced:             9,
  DigitalCreation:                    10,  DataDrivenMedia:                    11,
  TrainedAlgorithmicMedia:            12,  AlgorithmicMedia:                   13,
  ScreenCapture:                      14,  VirtualRecording:                   15,
  Composite:                          16,  CompositeCapture:                   17,
  CompositeSynthetic:                 18,
} as const;

// ── Library loading ──────────────────────────────────────────────────────────

function findLibraryPath(): string {
  if (process.env.C2PA_LIBRARY_PATH) return process.env.C2PA_LIBRARY_PATH;

  const plat = platform();
  const libName = plat === 'darwin' ? 'libc2pa_c.dylib'
                : plat === 'win32'  ? 'c2pa_c.dll'
                :                    'libc2pa_c.so';

  const searchPaths = [
    join(__dirname, '..', 'libs', libName),
    join(__dirname, '..', 'artifacts', libName),
    join(__dirname, '..', '..', 'c2pa-rs', 'target', 'debug', libName),
    join(__dirname, '..', '..', 'c2pa-rs', 'target', 'release', libName),
  ];

  for (const p of searchPaths) {
    if (existsSync(p)) return p;
  }
  return libName;
}

// ── Function declarations ────────────────────────────────────────────────────

export type Lib = ReturnType<typeof createLib>;
let _lib: Lib | null = null;

export function getLib(): Lib {
  if (!_lib) _lib = createLib(findLibraryPath());
  return _lib;
}

export function loadLibrary(path?: string): void {
  _lib = createLib(path ?? findLibraryPath());
}

function createLib(libPath: string) {
  const lib = koffi.load(libPath);
  const optionalFunc = (name: string, resultType: string, argTypes: unknown[]) => {
    try {
      return lib.func(name, resultType, argTypes as never[]);
    } catch {
      return null;
    }
  };

  return {
    // Version / error
    c2pa_version:        lib.func('c2pa_version',        'void *', []),
    c2pa_error:          lib.func('c2pa_error',           'void *', []),
    c2pa_error_set_last: lib.func('c2pa_error_set_last',  'int',    ['str']),
    c2pa_free:           lib.func('c2pa_free',            'int',    ['void *']),
    c2pa_free_string_array: lib.func('c2pa_free_string_array', 'void', ['void *', 'uintptr_t']),

    // Streams — callback params use 'TypeName *' string references
    c2pa_create_stream:  lib.func('c2pa_create_stream', 'C2paStream *', [
      'void *',
      'ReadCallback *', 'SeekCallback *', 'WriteCallback *', 'FlushCallback *',
    ]),
    c2pa_release_stream: lib.func('c2pa_release_stream', 'void', ['C2paStream *']),

    // Settings
    c2pa_settings_new:                lib.func('c2pa_settings_new',                'C2paSettings *', []),
    c2pa_settings_update_from_string: lib.func('c2pa_settings_update_from_string', 'int', ['C2paSettings *', 'str', 'str']),
    c2pa_settings_set_value:          lib.func('c2pa_settings_set_value',          'int', ['C2paSettings *', 'str', 'str']),

    // Context builder
    c2pa_context_builder_new:                   lib.func('c2pa_context_builder_new',                   'C2paContextBuilder *', []),
    c2pa_context_builder_set_settings:          lib.func('c2pa_context_builder_set_settings',          'int', ['C2paContextBuilder *', 'C2paSettings *']),
    c2pa_context_builder_set_signer:            lib.func('c2pa_context_builder_set_signer',            'int', ['C2paContextBuilder *', 'C2paSigner *']),
    c2pa_context_builder_set_progress_callback: lib.func('c2pa_context_builder_set_progress_callback', 'int', ['C2paContextBuilder *', 'void *', 'ProgressCallback *']),
    c2pa_context_builder_set_http_resolver:     lib.func('c2pa_context_builder_set_http_resolver',     'int', ['C2paContextBuilder *', 'C2paHttpResolver *']),
    c2pa_context_builder_build:                 lib.func('c2pa_context_builder_build',                 'C2paContext *', ['C2paContextBuilder *']),

    // Context
    c2pa_context_new:    lib.func('c2pa_context_new',    'C2paContext *', []),
    c2pa_context_cancel: lib.func('c2pa_context_cancel', 'int',           ['C2paContext *']),

    // Reader
    c2pa_reader_from_context: lib.func('c2pa_reader_from_context', 'C2paReader *', ['C2paContext *']),
    c2pa_reader_with_stream:  lib.func('c2pa_reader_with_stream',  'C2paReader *', ['C2paReader *', 'str', 'C2paStream *']),
    c2pa_reader_with_manifest_data_and_stream: lib.func(
      'c2pa_reader_with_manifest_data_and_stream', 'C2paReader *',
      ['C2paReader *', 'str', 'C2paStream *', 'void *', 'uintptr_t'],
    ),
    c2pa_reader_with_fragment: lib.func('c2pa_reader_with_fragment', 'C2paReader *', ['C2paReader *', 'str', 'C2paStream *', 'C2paStream *']),
    c2pa_reader_json:           lib.func('c2pa_reader_json',           'void *', ['C2paReader *']),
    c2pa_reader_detailed_json:  lib.func('c2pa_reader_detailed_json',  'void *', ['C2paReader *']),
    c2pa_reader_remote_url:     lib.func('c2pa_reader_remote_url',     'str',    ['C2paReader *']),  // NOT owned
    c2pa_reader_is_embedded:    lib.func('c2pa_reader_is_embedded',    'bool',   ['C2paReader *']),
    c2pa_reader_resource_to_stream: lib.func('c2pa_reader_resource_to_stream', 'int64', ['C2paReader *', 'str', 'C2paStream *']),
    c2pa_reader_supported_mime_types: lib.func('c2pa_reader_supported_mime_types', 'void *', [koffi.out(koffi.pointer('uintptr_t'))]),

    // Builder
    c2pa_builder_from_context:         lib.func('c2pa_builder_from_context',         'C2paBuilder *', ['C2paContext *']),
    c2pa_builder_supported_mime_types: lib.func('c2pa_builder_supported_mime_types', 'void *',        [koffi.out(koffi.pointer('uintptr_t'))]),
    c2pa_builder_with_definition:      lib.func('c2pa_builder_with_definition',      'C2paBuilder *', ['C2paBuilder *', 'str']),
    c2pa_builder_with_archive:         lib.func('c2pa_builder_with_archive',         'C2paBuilder *', ['C2paBuilder *', 'C2paStream *']),
    c2pa_builder_set_intent:           lib.func('c2pa_builder_set_intent',           'int',           ['C2paBuilder *', 'int', 'int']),
    c2pa_builder_set_no_embed:         lib.func('c2pa_builder_set_no_embed',         'void',          ['C2paBuilder *']),
    c2pa_builder_set_remote_url:       lib.func('c2pa_builder_set_remote_url',       'int',           ['C2paBuilder *', 'str']),
    c2pa_builder_set_base_path:        lib.func('c2pa_builder_set_base_path',        'int',           ['C2paBuilder *', 'str']),
    c2pa_builder_add_resource:         lib.func('c2pa_builder_add_resource',         'int',           ['C2paBuilder *', 'str', 'C2paStream *']),
    c2pa_builder_add_ingredient_from_stream: lib.func('c2pa_builder_add_ingredient_from_stream', 'int', ['C2paBuilder *', 'str', 'str', 'C2paStream *']),
    c2pa_builder_add_action:           lib.func('c2pa_builder_add_action',           'int',           ['C2paBuilder *', 'str']),
    c2pa_builder_to_archive:           lib.func('c2pa_builder_to_archive',           'int',           ['C2paBuilder *', 'C2paStream *']),
    c2pa_builder_add_ingredient_from_archive: lib.func('c2pa_builder_add_ingredient_from_archive', 'int', ['C2paBuilder *', 'C2paStream *']),
    c2pa_builder_write_ingredient_archive: lib.func('c2pa_builder_write_ingredient_archive', 'int', ['C2paBuilder *', 'str', 'C2paStream *']),
    c2pa_builder_needs_placeholder:    lib.func('c2pa_builder_needs_placeholder',    'int',  ['C2paBuilder *', 'str']),
    c2pa_builder_hash_type:            lib.func('c2pa_builder_hash_type',            'int',  ['C2paBuilder *', 'str', koffi.out(koffi.pointer('int'))]),
    c2pa_builder_set_data_hash_exclusions: lib.func('c2pa_builder_set_data_hash_exclusions', 'int', ['C2paBuilder *', 'void *', 'uintptr_t']),
    c2pa_builder_set_fixed_size_merkle:    lib.func('c2pa_builder_set_fixed_size_merkle',    'int', ['C2paBuilder *', 'uintptr_t']),
    c2pa_builder_hash_mdat_bytes:          lib.func('c2pa_builder_hash_mdat_bytes',           'int', ['C2paBuilder *', 'uintptr_t', 'void *', 'uintptr_t', 'bool']),
    c2pa_builder_update_hash_from_stream:  lib.func('c2pa_builder_update_hash_from_stream',   'int', ['C2paBuilder *', 'str', 'C2paStream *']),

    // sign — manifest_bytes_ptr passed as null (output goes to dest stream)
    c2pa_builder_sign:         lib.func('c2pa_builder_sign',         'int64', ['C2paBuilder *', 'str', 'C2paStream *', 'C2paStream *', 'C2paSigner *', 'void *']),
    c2pa_builder_sign_context: lib.func('c2pa_builder_sign_context', 'int64', ['C2paBuilder *', 'str', 'C2paStream *', 'C2paStream *', 'void *']),

    // embeddable signing — bytes are the primary output (out pointer-to-pointer)
    c2pa_builder_placeholder:             lib.func('c2pa_builder_placeholder',             'int64', ['C2paBuilder *', 'str', koffi.out(koffi.pointer('void *'))]),
    c2pa_builder_sign_embeddable:         lib.func('c2pa_builder_sign_embeddable',         'int64', ['C2paBuilder *', 'str', koffi.out(koffi.pointer('void *'))]),
    c2pa_builder_sign_data_hashed_embeddable: lib.func('c2pa_builder_sign_data_hashed_embeddable', 'int64', ['C2paBuilder *', 'C2paSigner *', 'str', 'str', 'C2paStream *', koffi.out(koffi.pointer('void *'))]),
    c2pa_builder_data_hashed_placeholder: lib.func('c2pa_builder_data_hashed_placeholder', 'int64', ['C2paBuilder *', 'uintptr_t', 'str', koffi.out(koffi.pointer('void *'))]),
    c2pa_format_embeddable:               lib.func('c2pa_format_embeddable',               'int64', ['str', 'void *', 'uintptr_t', koffi.out(koffi.pointer('void *'))]),

    // Signer
    c2pa_signer_create:           lib.func('c2pa_signer_create',     'C2paSigner *', ['void *', 'SignerCallback *', 'int', 'str', 'str']),
    c2pa_identity_signer_create:  optionalFunc('c2pa_identity_signer_create', 'C2paSigner *', ['C2paSigner *', 'C2paSigner *', 'void *', 'void *']),
    c2pa_signer_from_info:        lib.func('c2pa_signer_from_info',   'C2paSigner *', [koffi.pointer(SignerInfoType)]),
    c2pa_signer_reserve_size:     lib.func('c2pa_signer_reserve_size','int64',        ['C2paSigner *']),
    c2pa_ed25519_sign:            lib.func('c2pa_ed25519_sign',       'void *',       ['void *', 'uintptr_t', 'str']),
  };
}

// ── Shared helpers ───────────────────────────────────────────────────────────

// MAX_CSTRING_LEN from c2pa.h (1 MB). koffi.decode stops at the null terminator.
const MAX_CSTRING_LEN = 1_048_576;

/** Read a Rust-allocated null-terminated string and free it. */
export function decodeAndFree(ptr: unknown): string {
  if (!ptr) return '';
  const str = koffi.decode(ptr, 'char', MAX_CSTRING_LEN) as string;
  getLib().c2pa_free(ptr);
  return str;
}

/** Read N bytes from a Rust-allocated buffer and free it. */
export function decodeBytesAndFree(ptr: unknown, size: number): Buffer {
  if (!ptr || size <= 0) return Buffer.alloc(0);
  const arr = koffi.decode(ptr, 'uint8_t', size) as Uint8Array;
  getLib().c2pa_free(ptr);
  return Buffer.from(arr);
}

/** Convert number | bigint to number (stream/size values never exceed 2^53). */
export function toNum(v: number | bigint): number {
  return typeof v === 'bigint' ? Number(v) : v;
}
