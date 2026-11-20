import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import AdmZip from 'adm-zip';
import { isBlockedIp, assertSafeTarget, PermanentError } from '../src/url-guard.js';
import { scanZip } from '../src/scan.js';
import { processJob } from '../src/process.js';

const fixture = fs.readFileSync(new URL('./fixture-vulnerable.js', import.meta.url));

test('blocks private, loopback, metadata and IPv6 local addresses', () => {
  for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:169.254.169.254']) {
    assert.equal(isBlockedIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '100.128.0.1', '2607:f8b0::1']) {
    assert.equal(isBlockedIp(ip), false, ip);
  }
});

test('rejects a host name that resolves to an internal address', async () => {
  const resolve = async () => [{ address: '10.0.0.5' }];
  await assert.rejects(assertSafeTarget('http://sneaky.example/', resolve), PermanentError);
  await assert.rejects(assertSafeTarget('http://169.254.169.254/latest/', resolve), PermanentError);
  await assert.rejects(assertSafeTarget('ftp://example.com/', resolve), PermanentError);
  await assertSafeTarget('http://ok.example/', async () => [{ address: '8.8.8.8' }]);
});

test('scans JavaScript in a zip and skips node_modules and other file types', () => {
  const zip = new AdmZip();
  zip.addFile('src/app.js', fixture);
  zip.addFile('node_modules/lib/index.js', fixture);
  zip.addFile('notes.txt', Buffer.from('password = "admin123"'));
  const { report, summary } = scanZip(zip.toBuffer());
  assert.equal(summary.filesScanned, 1);
  assert.ok(summary.high > 0);
  assert.ok(report.findings.every((f) => f.file === 'src/app.js'));
});

test('a zip entry with a path traversal name is ignored and never written to disk', () => {
  const evilPath = `/tmp/evil-scanner-test-${process.pid}.js`;
  const zip = new AdmZip();
  zip.addFile('safe.js', Buffer.from('eval(userInput);'));
  zip.getEntries()[0].entryName = `../../..${evilPath}`;
  const { summary } = scanZip(zip.toBuffer());
  assert.equal(summary.filesScanned, 0);
  assert.equal(fs.existsSync(evilPath), false);
});

test('a file that is not a zip fails permanently', () => {
  assert.throws(() => scanZip(Buffer.from('not a zip')), PermanentError);
});

function fakeStore(job) {
  const calls = [];
  return {
    calls,
    getJob: async () => job,
    markRunning: async () => { calls.push('running'); return true; },
    markCompleted: async (t, j, key, summary) => calls.push(['completed', key, summary]),
    markFailed: async (t, j, message) => calls.push(['failed', message]),
    readUpload: async () => Buffer.from('zip'),
    writeReport: async (key) => calls.push(['report', key]),
  };
}
const message = { teamId: 'team-a', jobId: 'j1' };

test('a finished job is skipped if SQS delivers it twice', async () => {
  const store = fakeStore({ status: 'COMPLETED' });
  assert.equal(await processJob(message, store, {}), true);
  assert.deepEqual(store.calls, []);
});

test('a successful scan saves the report under the team and marks COMPLETED', async () => {
  const store = fakeStore({ status: 'QUEUED', scanType: 'SAST', uploadKey: 'u' });
  const scanners = { scanZip: () => ({ report: {}, summary: { total: 1 } }) };
  assert.equal(await processJob(message, store, scanners), true);
  assert.deepEqual(store.calls, ['running', ['report', 'reports/team-a/j1.json'], ['completed', 'reports/team-a/j1.json', { total: 1 }]]);
});

test('a bad job is marked FAILED and its message is removed', async () => {
  const store = fakeStore({ status: 'QUEUED', scanType: 'PENTEST', targetUrl: 'http://x' });
  const scanners = { scanTarget: async () => { throw new PermanentError('blocked'); } };
  assert.equal(await processJob(message, store, scanners), true);
  assert.deepEqual(store.calls.at(-1), ['failed', 'blocked']);
});

test('a temporary failure keeps the message so SQS can retry', async () => {
  const store = fakeStore({ status: 'QUEUED', scanType: 'PENTEST', targetUrl: 'http://x' });
  const scanners = { scanTarget: async () => { throw new Error('network down'); } };
  assert.equal(await processJob(message, store, scanners), false);
});

test('a job that was already failed elsewhere is not scanned again', async () => {
  const store = fakeStore({ status: 'QUEUED', scanType: 'SAST', uploadKey: 'u' });
  store.markRunning = async () => false;
  let scanned = false;
  const scanners = { scanZip: () => { scanned = true; return { report: {}, summary: {} }; } };
  assert.equal(await processJob(message, store, scanners), true);
  assert.equal(scanned, false);
});

test('a pentest that runs past the time limit is marked FAILED', async () => {
  const store = fakeStore({ status: 'QUEUED', scanType: 'PENTEST', targetUrl: 'http://x' });
  const scanners = { scanTarget: () => new Promise((resolve) => setTimeout(resolve, 200)) };
  assert.equal(await processJob(message, store, scanners, 10), true);
  assert.deepEqual(store.calls.at(-1), ['failed', 'Scan took too long and was stopped']);
});
