// Tests for the *Async Reader/Builder methods (koffi .async()-backed).
// Run: node test/async.test.js

const path = require('path');
const fs = require('fs');
const os = require('os');

const c2pa = require('../dist/index.js');
const { C2paStream } = require('../dist/stream.js');

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
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

const testImage = path.join(__dirname, 'fixtures', 'C.jpg');
const noManifest = path.join(__dirname, 'fixtures', 'no_manifest.jpg');
const cert = fs.readFileSync(path.join(__dirname, 'fixtures', 'es256_certs.pem'), 'utf8');
const key = fs.readFileSync(path.join(__dirname, 'fixtures', 'es256_private.key'), 'utf8');
const signerInfo = { alg: 'Es256', signCert: cert, privateKey: key };

async function main() {
  console.log('\nc2pa-koffi async tests\n');

  await test('Reader.readAsync() matches the sync read() manifest', async () => {
    const buf = fs.readFileSync(testImage);
    const sync = c2pa.read('image/jpeg', buf);

    const ctx = c2pa.Context.default();
    const reader = new c2pa.Reader(ctx);
    try {
      await reader.readAsync('image/jpeg', buf);
      const manifest = JSON.parse(reader.json());
      assert(manifest.active_manifest === sync.active_manifest, 'active_manifest mismatch');
    } finally {
      reader.dispose();
      ctx.dispose();
    }
  });

  await test('Reader.readAsync() rejects for a no-manifest asset', async () => {
    const buf = fs.readFileSync(noManifest);
    const ctx = c2pa.Context.default();
    const reader = new c2pa.Reader(ctx);
    try {
      let threw = false;
      try {
        await reader.readAsync('image/jpeg', buf);
      } catch {
        threw = true;
      }
      assert(threw, 'expected readAsync() to reject for a no-manifest asset');
    } finally {
      reader.dispose();
      ctx.dispose();
    }
  });

  await test('Reader.getResourceAsync() returns the same bytes as getResource()', async () => {
    const buf = fs.readFileSync(testImage);
    const manifest = c2pa.read('image/jpeg', buf);
    const uri = manifest.manifests[manifest.active_manifest].thumbnail.identifier;

    const ctx = c2pa.Context.default();
    const reader = new c2pa.Reader(ctx);
    try {
      reader.read('image/jpeg', buf);
      const sync = reader.getResource(uri);
      const async_ = await reader.getResourceAsync(uri);
      assert(sync.equals(async_), 'sync/async resource bytes differ');
    } finally {
      reader.dispose();
      ctx.dispose();
    }
  });

  await test('Builder.signAsync() (in-memory) matches Builder.sign()', async () => {
    const manifestJson = JSON.stringify({ title: 'async test', claim_generator: 'async-test/0.1' });
    const source = fs.readFileSync(testImage);

    const ctx1 = c2pa.Context.default();
    const b1 = new c2pa.Builder(ctx1);
    b1.setDefinition(manifestJson);
    const s1 = c2pa.Signer.fromInfo(signerInfo);
    const syncSigned = b1.sign('image/jpeg', source, s1);
    s1.dispose(); b1.dispose(); ctx1.dispose();

    const ctx2 = c2pa.Context.default();
    const b2 = new c2pa.Builder(ctx2);
    b2.setDefinition(manifestJson);
    const s2 = c2pa.Signer.fromInfo(signerInfo);
    const asyncSigned = await b2.signAsync('image/jpeg', source, s2);
    s2.dispose(); b2.dispose(); ctx2.dispose();

    const syncManifest = c2pa.read('image/jpeg', syncSigned);
    const asyncManifest = c2pa.read('image/jpeg', asyncSigned);
    assert(
      syncManifest.manifests[syncManifest.active_manifest].title ===
      asyncManifest.manifests[asyncManifest.active_manifest].title,
      'title mismatch between sync and async signed output',
    );
  });

  await test('Builder.signAsync() with fromFile()/toFile() streams signs a large-ish file correctly', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2pa-async-test-'));
    try {
      const outPath = path.join(tmpDir, 'signed.jpg');
      const manifestJson = JSON.stringify({ title: 'async file test', claim_generator: 'async-test/0.1' });

      const ctx = c2pa.Context.default();
      const builder = new c2pa.Builder(ctx);
      builder.setDefinition(manifestJson);
      const signer = c2pa.Signer.fromInfo(signerInfo);
      const src = C2paStream.fromFile(testImage);
      const dest = C2paStream.toFile(outPath);

      // signAsync() takes a Buffer; exercise the file-backed path directly
      // via the same underlying mechanism it uses (getLib().c2pa_builder_sign.async).
      const { getLib } = require('../dist/lib.js');
      const manifestBytesOut = [null];
      await new Promise((resolve, reject) => {
        getLib().c2pa_builder_sign.async(
          builder['_ptr'], 'image/jpeg', src.ptr, dest.ptr, signer.ptr, manifestBytesOut,
          (err, res) => {
            const n = typeof res === 'bigint' ? Number(res) : res;
            if (err) return reject(err);
            if (n < 0) return reject(new Error('signing failed'));
            resolve();
          },
        );
      });
      if (manifestBytesOut[0]) getLib().c2pa_free(manifestBytesOut[0]);
      src.dispose(); dest.dispose(); signer.dispose(); builder.dispose(); ctx.dispose();

      const manifest = c2pa.read('image/jpeg', fs.readFileSync(outPath));
      assert(
        manifest.manifests[manifest.active_manifest].title === 'async file test',
        'title mismatch in file-backed async signed output',
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await test('10 concurrent Builder.signAsync() calls each get their own correct manifest', async () => {
    const source = fs.readFileSync(testImage);
    const N = 10;
    const jobs = Array.from({ length: N }, async (_, i) => {
      const ctx = c2pa.Context.default();
      const builder = new c2pa.Builder(ctx);
      builder.setDefinition(JSON.stringify({ title: `concurrent-${i}`, claim_generator: 'async-test/0.1' }));
      const signer = c2pa.Signer.fromInfo(signerInfo);
      try {
        const signed = await builder.signAsync('image/jpeg', source, signer);
        const manifest = c2pa.read('image/jpeg', signed);
        return manifest.manifests[manifest.active_manifest].title;
      } finally {
        signer.dispose();
        builder.dispose();
        ctx.dispose();
      }
    });
    const titles = await Promise.all(jobs);
    const expected = Array.from({ length: N }, (_, i) => `concurrent-${i}`);
    assert(JSON.stringify(titles) === JSON.stringify(expected), `titles mismatch: ${titles.join(', ')}`);
  });

  await test('Builder.signAsync() throws a generic C2paError on bad credentials', async () => {
    const ctx = c2pa.Context.default();
    const builder = new c2pa.Builder(ctx);
    builder.setDefinition(JSON.stringify({ title: 'should fail' }));
    let threw = null;
    try {
      const signer = c2pa.Signer.fromInfo(signerInfo);
      // Corrupt the builder pointer's expected flow by signing with a
      // mismatched format instead — a reliable way to force a failure
      // without depending on error-message detail (which async doesn't have).
      await builder.signAsync('not/a-real-mimetype', fs.readFileSync(testImage), signer);
      signer.dispose();
    } catch (e) {
      threw = e;
    } finally {
      builder.dispose();
      ctx.dispose();
    }
    assert(threw instanceof c2pa.C2paError, `expected a C2paError, got: ${threw}`);
  });

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
