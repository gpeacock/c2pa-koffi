// Tests for the C2paStream backends (buffer aliasing, file-backed streams).
// Run: node test/stream.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const c2pa = require('../dist/index.js');
const { C2paStream } = require('../dist/stream.js');
const { getLib } = require('../dist/lib.js');
const { checkInt } = require('../dist/error.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.stack || e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'Assertion failed');
}

console.log('\nc2pa-koffi stream tests\n');

const testImage = path.join(__dirname, 'fixtures', 'C.jpg');
assert(fs.existsSync(testImage), `Missing required test fixture: ${testImage}`);

// Reads a manifest through a raw Reader driven by a caller-supplied stream,
// bypassing Reader.read()'s hardcoded fromBuffer.
function readViaStream(mimeType, stream) {
  const ctx = c2pa.Context.default();
  const readerPtr = getLib().c2pa_reader_from_context(ctx.ptr);
  try {
    const newPtr = getLib().c2pa_reader_with_stream(readerPtr, mimeType, stream.ptr);
    if (!newPtr) throw new Error('c2pa_reader_with_stream failed');
    const jsonPtr = getLib().c2pa_reader_json(newPtr);
    const { decodeAndFree } = require('../dist/lib.js');
    const json = decodeAndFree(jsonPtr);
    getLib().c2pa_free(newPtr);
    return JSON.parse(json);
  } finally {
    ctx.dispose();
  }
}

// ── fromFile / fromBuffer parity ─────────────────────────────────────────────

test('fromFile() produces the same manifest as fromBuffer()', () => {
  const buf = fs.readFileSync(testImage);
  const viaBuffer = c2pa.read('image/jpeg', buf);

  const fileStream = C2paStream.fromFile(testImage);
  let viaFile;
  try {
    viaFile = readViaStream('image/jpeg', fileStream);
  } finally {
    fileStream.dispose();
  }

  assert(viaFile.active_manifest === viaBuffer.active_manifest, 'active_manifest mismatch');
});

// ── fromBuffer aliasing (zero-copy) ──────────────────────────────────────────

test('fromBuffer() aliases the input buffer instead of copying it', () => {
  const buf = fs.readFileSync(testImage);
  const stream = C2paStream.fromBuffer(buf);
  try {
    // Corrupt the source buffer *after* the stream was created but before
    // it's read. If fromBuffer() had copied the data, this read would still
    // succeed against the untouched copy.
    buf.fill(0);
    let threw = false;
    try {
      readViaStream('image/jpeg', stream);
    } catch {
      threw = true;
    }
    assert(threw, 'expected read to fail against zeroed-out aliased buffer');
  } finally {
    stream.dispose();
  }
});

// ── write growth + getBytes() (zero-copy) via a real native write path ──────

test('getResource() returns valid bytes via BufferBackend write + getBytes()', () => {
  const buf = fs.readFileSync(testImage);
  const manifest = c2pa.read('image/jpeg', buf);
  const uri = manifest.manifests[manifest.active_manifest].thumbnail.identifier;

  const ctx = c2pa.Context.default();
  const reader = new c2pa.Reader(ctx);
  try {
    reader.read('image/jpeg', buf);
    const resource = reader.getResource(uri);
    assert(Buffer.isBuffer(resource) && resource.length > 0, 'expected non-empty resource buffer');
    // JPEG magic bytes
    assert(resource[0] === 0xff && resource[1] === 0xd8, 'expected JPEG SOI marker');
  } finally {
    reader.dispose();
    ctx.dispose();
  }
});

// ── toFile() destination + fromFile() source: full sign round-trip ─────────

// c2pa-rs rejects self-signed leaf certs outright, so a locally-generated
// single cert won't pass signing validation. Use the ES256 sample
// credentials (leaf + intermediate chain), vendored from c2pa-rs's own CLI
// sample directory, which is exactly what they're there for.
function loadTestEs256() {
  return {
    key: fs.readFileSync(path.join(__dirname, 'fixtures', 'es256_private.key'), 'utf8'),
    cert: fs.readFileSync(path.join(__dirname, 'fixtures', 'es256_certs.pem'), 'utf8'),
  };
}

test('sign into a toFile() destination matches sign into an in-memory buffer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2pa-stream-test-'));
  try {
    const { key, cert } = loadTestEs256();
    const signerInfo = { alg: 'Es256', signCert: cert, privateKey: key };
    const manifestJson = JSON.stringify({ title: 'stream test', claim_generator: 'stream-test/0.1' });

    // Reference: existing buffer-only path.
    const bufSigner = c2pa.Signer.fromInfo(signerInfo);
    let bufSigned;
    try {
      bufSigned = c2pa.sign('image/jpeg', fs.readFileSync(testImage), manifestJson, bufSigner);
    } finally {
      bufSigner.dispose();
    }

    // New: sign straight to disk via toFile(), reading the source via fromFile().
    const outPath = path.join(tmpDir, 'signed.jpg');
    const ctx = c2pa.Context.default();
    const builder = new c2pa.Builder(ctx);
    const fileSigner = c2pa.Signer.fromInfo(signerInfo);
    const srcStream = C2paStream.fromFile(testImage);
    const destStream = C2paStream.toFile(outPath);
    const manifestBytesOut = [null];
    try {
      builder.setDefinition(manifestJson);
      checkInt(
        getLib().c2pa_builder_sign(builder['_ptr'], 'image/jpeg', srcStream.ptr, destStream.ptr, fileSigner.ptr, manifestBytesOut),
        'Signing to file failed',
      );
    } finally {
      if (manifestBytesOut[0]) getLib().c2pa_free(manifestBytesOut[0]);
      srcStream.dispose();
      destStream.dispose();
      fileSigner.dispose();
      builder.dispose();
      ctx.dispose();
    }

    const fileSigned = fs.readFileSync(outPath);
    assert(fileSigned.length > 0, 'expected non-empty signed file');

    const manifestFromFile = c2pa.read('image/jpeg', fileSigned);
    const manifestFromBuf = c2pa.read('image/jpeg', bufSigned);
    assert(manifestFromFile !== null, 'expected a manifest in the file-signed asset');
    const activeFile = manifestFromFile.manifests[manifestFromFile.active_manifest];
    const activeBuf = manifestFromBuf.manifests[manifestFromBuf.active_manifest];
    assert(activeFile.title === activeBuf.title, 'title mismatch between file-signed and buffer-signed assets');
    assert(activeFile.title === 'stream test', `unexpected title: ${activeFile.title}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
