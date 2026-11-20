// Bridges the job runner to the SAST and Pentest scanners.
import AdmZip from 'adm-zip';
import path from 'node:path';
import { scanCode } from '../tools/sast/backend/scanner.js';
import { runAllTests } from '../tools/pentest/backend/tester.js';
import { assertSafeTarget, PermanentError } from './url-guard.js';

const EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.ts']);
const MAX_FILES = 5000;
const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

const skipped = (name) => name.split('/').some((part) => part === 'node_modules' || part.startsWith('.'));

// Skip node_modules and hidden folders
export function scanZip(zipBytes) {
  let entries;
  try {
    entries = new AdmZip(zipBytes).getEntries();
  } catch {
    throw new PermanentError('Upload is not a valid zip file');
  }
  const files = entries.filter((e) =>
    !e.isDirectory && EXTENSIONS.has(path.extname(e.entryName).toLowerCase()) && !skipped(e.entryName));
  if (files.length > MAX_FILES) throw new PermanentError(`Too many files (limit ${MAX_FILES})`);
  const total = files.reduce((sum, e) => sum + e.header.size, 0);
  if (total > MAX_TOTAL_BYTES) throw new PermanentError('Zip is too large once unpacked');

  const findings = files.flatMap((e) => scanCode(e.getData().toString('utf8'), e.entryName));
  const count = (severity) => findings.filter((f) => f.severity === severity).length;
  return {
    report: { filesScanned: files.length, findings },
    summary: {
      filesScanned: files.length, total: findings.length,
      high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW'),
    },
  };
}

export async function scanTarget(targetUrl) {
  await assertSafeTarget(targetUrl);
  const results = await runAllTests(targetUrl, {});
  const count = (status) => results.filter((r) => r.status === status).length;
  return {
    report: { targetUrl, results },
    summary: {
      total: results.length, passed: count('PASS'), failed: count('FAIL'),
      warnings: count('WARNING'), errors: count('ERROR'),
    },
  };
}
