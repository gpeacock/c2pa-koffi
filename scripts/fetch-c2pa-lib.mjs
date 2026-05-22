#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import { spawnSync } from 'node:child_process';

const OWNER = 'contentauth';
const REPO = 'c2pa-rs';
const RELEASE_PREFIX = 'c2pa-v';

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function info(message) {
  console.log(message);
}

function getTargetLibName() {
  switch (process.platform) {
    case 'darwin':
      return 'libc2pa_c.dylib';
    case 'linux':
      return 'libc2pa_c.so';
    case 'win32':
      return 'c2pa_c.dll';
    default:
      fail(`Unsupported platform: ${process.platform}`);
  }
}

function getPlatformTokens() {
  const arch = process.arch;

  if (process.platform === 'darwin') {
    if (arch === 'arm64') return ['apple-darwin', 'darwin', 'macos', 'osx', 'universal', 'aarch64', 'arm64'];
    if (arch === 'x64') return ['apple-darwin', 'darwin', 'macos', 'osx', 'universal', 'x86_64', 'x64'];
  }

  if (process.platform === 'linux') {
    if (arch === 'x64') return ['unknown-linux-gnu', 'linux-gnu', 'linux', 'x86_64', 'amd64', 'x64'];
    if (arch === 'arm64') return ['unknown-linux-gnu', 'linux-gnu', 'linux', 'aarch64', 'arm64'];
  }

  if (process.platform === 'win32') {
    if (arch === 'x64') return ['pc-windows-msvc', 'windows-msvc', 'windows', 'win', 'x86_64', 'x64'];
    if (arch === 'arm64') return ['pc-windows-msvc', 'windows-msvc', 'windows', 'win', 'aarch64', 'arm64'];
  }

  return [process.platform, arch];
}

function apiGetJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'c2pa-koffi-fetch-script',
        'Accept': 'application/vnd.github+json',
      },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`GitHub API request failed (${res.statusCode}): ${url}`));
          return;
        }
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON from ${url}: ${e.message}`));
        }
      });
    });
    req.on('error', reject);
  });
}

function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers: { 'User-Agent': 'c2pa-koffi-fetch-script' },
    }, (res) => {
      if (res.statusCode && [301, 302, 303, 307, 308].includes(res.statusCode)) {
        if (!res.headers.location) {
          reject(new Error(`Redirect missing location for ${url}`));
          return;
        }
        downloadFile(res.headers.location, destination).then(resolve).catch(reject);
        return;
      }

      if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
        reject(new Error(`Download failed (${res.statusCode}): ${url}`));
        return;
      }

      const out = fs.createWriteStream(destination);
      res.pipe(out);
      out.on('finish', () => out.close(resolve));
      out.on('error', reject);
    });

    request.on('error', reject);
  });
}

function runCommand(command, args, options = {}) {
  const ret = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8', ...options });
  if (ret.status !== 0) {
    const stderr = (ret.stderr || '').trim();
    const stdout = (ret.stdout || '').trim();
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : stdout ? `: ${stdout}` : ''}`);
  }
  return ret.stdout;
}

function extractLibrary(archivePath, outputPath, libName) {
  const lower = archivePath.toLowerCase();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2pa-lib-extract-'));

  try {
    if (lower.endsWith('.zip')) {
      const listing = runCommand('unzip', ['-Z1', archivePath]);
      const entry = listing.split('\n').find((line) => line.trim().endsWith(libName));
      if (!entry) throw new Error(`No ${libName} found in zip asset`);
      // Extract directly to disk to avoid binary-to-text corruption.
      runCommand('unzip', ['-j', archivePath, entry, '-d', tempDir]);
      const extracted = path.join(tempDir, libName);
      if (!fs.existsSync(extracted)) {
        throw new Error(`Failed to extract ${libName} from zip asset`);
      }
      fs.copyFileSync(extracted, outputPath);
      return;
    }

    if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
      runCommand('tar', ['-xzf', archivePath, '-C', tempDir]);
      const found = findFileByName(tempDir, libName);
      if (!found) throw new Error(`No ${libName} found in tar asset`);
      fs.copyFileSync(found, outputPath);
      return;
    }

    throw new Error(`Unsupported archive format: ${archivePath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function findFileByName(root, fileName) {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      const nested = findFileByName(fullPath, fileName);
      if (nested) return nested;
    } else if (entry.isFile() && entry.name === fileName) {
      return fullPath;
    }
  }
  return null;
}

function chooseRelease(releases) {
  const cReleases = releases
    .filter((r) => typeof r?.tag_name === 'string' && r.tag_name.startsWith(RELEASE_PREFIX))
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0));

  if (cReleases.length === 0) {
    fail(`No releases matching ${RELEASE_PREFIX}* were found.`);
  }

  return cReleases;
}

function chooseAsset(assets, tokens) {
  if (!assets || assets.length === 0) return null;

  const validExt = (name) => {
    const n = name.toLowerCase();
    return n.endsWith('.zip') || n.endsWith('.tar.gz') || n.endsWith('.tgz') || n.endsWith('.dylib') || n.endsWith('.so') || n.endsWith('.dll');
  };

  const extAssets = assets.filter((a) => validExt(a.name || ''));
  if (extAssets.length === 0) return null;

  const scored = extAssets
    .map((a) => {
      const n = (a.name || '').toLowerCase();
      const score = tokens.reduce((acc, t) => acc + (n.includes(t) ? 1 : 0), 0);
      return { asset: a, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0].score > 0 ? scored[0].asset : null;
}

async function main() {
  const root = process.cwd();
  const libsDir = path.join(root, 'libs');
  const targetLib = getTargetLibName();
  const targetPath = path.join(libsDir, targetLib);
  const tokens = getPlatformTokens();

  fs.mkdirSync(libsDir, { recursive: true });

  info(`Detecting release for ${process.platform}/${process.arch}...`);
  const releases = await apiGetJson(`https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`);
  const ordered = chooseRelease(releases);

  let chosenRelease = null;
  let chosenAsset = null;

  for (const release of ordered) {
    const asset = chooseAsset(release.assets, tokens);
    if (asset) {
      chosenRelease = release;
      chosenAsset = asset;
      break;
    }
  }

  if (!chosenRelease || !chosenAsset) {
    const newest = ordered[0]?.tag_name || 'unknown';
    fail(
      `No compatible binary asset found for ${process.platform}/${process.arch} in ${OWNER}/${REPO} ${RELEASE_PREFIX}* releases (newest: ${newest}). Build from source or set C2PA_LIBRARY_PATH manually.`,
    );
  }

  info(`Using release ${chosenRelease.tag_name}`);
  info(`Selected asset ${chosenAsset.name}`);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2pa-lib-download-'));
  const tempAssetPath = path.join(tempDir, chosenAsset.name);

  try {
    await downloadFile(chosenAsset.browser_download_url, tempAssetPath);

    const lower = chosenAsset.name.toLowerCase();
    if (lower.endsWith('.dylib') || lower.endsWith('.so') || lower.endsWith('.dll')) {
      fs.copyFileSync(tempAssetPath, targetPath);
    } else {
      extractLibrary(tempAssetPath, targetPath, targetLib);
    }

    info(`Wrote ${targetPath}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((err) => fail(err.message));
