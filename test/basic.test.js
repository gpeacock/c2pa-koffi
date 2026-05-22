// Basic smoke test — requires the native library to be present.
// Run: node test/basic.test.js
//
// Set C2PA_LIBRARY_PATH if the library isn't in the default search paths.

const path = require('path');
const fs   = require('fs');

// Point at the local dist build
const c2pa = require('../dist/index.js');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg ?? 'Assertion failed');
}

console.log('\nc2pa-koffi basic tests\n');

const noManifestPath = path.join(__dirname, 'fixtures', 'no_manifest.jpg');
const testImage = path.join(__dirname, 'fixtures', 'C.jpg');

assert(fs.existsSync(noManifestPath), `Missing required test fixture: ${noManifestPath}`);
assert(fs.existsSync(testImage), `Missing required test fixture: ${testImage}`);

// ── Library loading ──────────────────────────────────────────────────────────

test('version() returns a non-empty string', () => {
  const v = c2pa.version();
  assert(typeof v === 'string' && v.length > 0, `Expected version string, got: ${v}`);
  console.log(`    version: ${v}`);
});

// ── Reader (no-manifest asset) ───────────────────────────────────────────────

test('read() returns null for a JPEG with no manifest', () => {
  const buf = fs.readFileSync(noManifestPath);
  const result = c2pa.read('image/jpeg', buf);
  assert(result === null, `Expected null, got: ${JSON.stringify(result)}`);
});

// ── Reader against a real signed asset ──────────────────────────────────────
test('read() parses a signed JPEG and returns a manifest object', () => {
  const buf = fs.readFileSync(testImage);
  const manifest = c2pa.read('image/jpeg', buf);
  assert(manifest !== null, 'Expected manifest, got null');
  assert(typeof manifest === 'object', 'Expected object');
  console.log(`    active_manifest: ${manifest.active_manifest}`);
});

test('Reader class: read + json + detailedJson', () => {
  const buf = fs.readFileSync(testImage);
  const ctx = c2pa.Context.default();
  const reader = new c2pa.Reader(ctx);
  try {
    reader.read('image/jpeg', buf);
    const json = reader.json();
    assert(typeof json === 'string' && json.length > 0, 'Expected JSON string');
    const detailed = reader.detailedJson();
    assert(typeof detailed === 'string' && detailed.length > 0, 'Expected detailed JSON string');
    const isEmbedded = reader.isEmbedded();
    assert(typeof isEmbedded === 'boolean', 'Expected boolean');
  } finally {
    reader.dispose();
    ctx.dispose();
  }
});

// ── Settings ─────────────────────────────────────────────────────────────────

test('Settings.setValue does not throw', () => {
  const settings = new c2pa.Settings();
  try {
    settings.setValue('verify.verify_after_sign', 'false');
  } finally {
    settings.dispose();
  }
});

// ── ContextBuilder ────────────────────────────────────────────────────────────

test('ContextBuilder.build() produces a Context', () => {
  const settings = new c2pa.Settings();
  settings.setValue('verify.verify_after_sign', 'false');

  const ctx = new c2pa.ContextBuilder()
    .withSettings(settings)
    .build();

  settings.dispose();
  ctx.dispose();
});

// ── Builder (no-sign) ─────────────────────────────────────────────────────────

test('Builder constructs and disposes without error', () => {
  const ctx     = c2pa.Context.default();
  const builder = new c2pa.Builder(ctx);
  try {
    builder.setDefinition(JSON.stringify({ title: 'Test' }));
  } finally {
    builder.dispose();
    ctx.dispose();
  }
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
