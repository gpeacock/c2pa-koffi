# c2pa-koffi

Koffi-based Node.js bindings for the C2PA Rust library (`c2pa-rs` C ABI).

This repository is an example binding layer that loads the native `c2pa_c` library from Node.js and exposes a TypeScript-friendly API for:

- Reading/verifying C2PA manifests (`Reader`, `read`)
- Building/signing manifests (`Builder`, `sign`)
- Context/settings/signer configuration

## What This Is

- A Node.js + TypeScript wrapper around the `c2pa-rs` C API, implemented with [koffi](https://github.com/Koromix/koffi).
- A development/example project, not a published npm package workflow.
- A place to experiment with calling `c2pa-rs` from Node without writing a native Node addon.

## Prerequisites

- Node.js 20+ (Node 18+ may work, but 20+ is recommended)
- npm
- A built `c2pa_c` dynamic library from `c2pa-rs`:
  - macOS: `libc2pa_c.dylib`
  - Linux: `libc2pa_c.so`
  - Windows: `c2pa_c.dll`

## Native Library Setup

At runtime, the binding tries to load the native library in this order:

1. `C2PA_LIBRARY_PATH` environment variable
2. `libs/<platform-libname>`
3. `artifacts/<platform-libname>`
4. `../c2pa-rs/target/debug/<platform-libname>`
5. `../c2pa-rs/target/release/<platform-libname>`
6. System loader fallback by library filename

Recommended for this repo: put the library in `libs/`.

### Fetch From c2pa-rs Releases

This repo includes an automated fetch command that looks for the newest
`c2pa-v*` release in `contentauth/c2pa-rs`, selects a matching asset for
your current OS/CPU, and writes the extracted library to `libs/`.

```bash
npm run fetch:c2pa
```

Notes:

- The script downloads from GitHub Releases and supports direct library files,
  `.zip`, and `.tar.gz`/`.tgz` assets.
- If no compatible binary is published for your platform yet, it exits with a
  clear message. In that case, build `c2pa_c` from source and/or set
  `C2PA_LIBRARY_PATH`.

Example on macOS:

```bash
mkdir -p libs
cp /path/to/libc2pa_c.dylib libs/
```

Or set an explicit path:

```bash
export C2PA_LIBRARY_PATH=/absolute/path/to/libc2pa_c.dylib
```

## Install

```bash
npm install
```

Optional: fetch the native library automatically.

```bash
npm run fetch:c2pa
```

## Build

Compile TypeScript to `dist/`:

```bash
npm run build
```

## Test

Run the smoke test:

```bash
npm run test:js
```

Notes:

- This test uses `dist/index.js`, so run `npm run build` first.
- Test assets are stored locally under `test/fixtures/` (no cross-project dependency).
- `package.json` also contains `npm test`, but it currently references `test/basic.test.ts` while this repo contains `test/basic.test.js`.

## Run (Quick Example)

After building, run a quick version check:

```bash
node -e "const c2pa=require('./dist/index.js'); console.log(c2pa.version())"
```

Read a local signed image example:

```bash
node -e "const fs=require('fs'); const c2pa=require('./dist/index.js'); const buf=fs.readFileSync('path/to/image.jpg'); const m=c2pa.read('image/jpeg', buf); console.log(m ? m.active_manifest : 'No manifest found')"
```

## Project Layout

- `src/`: TypeScript binding implementation
- `dist/`: compiled output (generated)
- `libs/`: optional local native library location
- `test/basic.test.js`: smoke test
- `test/fixtures/`: local JPEG assets used by tests

## License

MIT OR Apache-2.0
