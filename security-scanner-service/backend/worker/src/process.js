// Runs one job end-to-end: marks it running, calls the scanner, saves the report.
import { PermanentError } from './url-guard.js';

export const SCAN_LIMIT_MS = 30 * 60 * 1000;

const withLimit = (scan, limitMs) => {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new PermanentError('Scan took too long and was stopped')), limitMs);
  });
  return Promise.race([scan, limit]).finally(() => clearTimeout(timer));
};

export async function processJob({ teamId, jobId }, store, scanners, limitMs = SCAN_LIMIT_MS) {
  const job = await store.getJob(teamId, jobId);
  if (!job) return true;
  if (job.status === 'COMPLETED' || job.status === 'FAILED') return true;

  if (!(await store.markRunning(teamId, jobId))) return true;

  try {
    const { report, summary } = job.scanType === 'SAST'
      ? scanners.scanZip(await store.readUpload(job.uploadKey))
      : await withLimit(scanners.scanTarget(job.targetUrl), limitMs);
    const reportKey = `reports/${teamId}/${jobId}.json`;
  
    await store.writeReport(reportKey, { jobId, teamId, scanType: job.scanType, ...report });
    await store.markCompleted(teamId, jobId, reportKey, summary);
    return true;
  } catch (error) {
    if (error instanceof PermanentError) {
      await store.markFailed(teamId, jobId, error.message);
      return true;
    }
    console.error(`Job ${jobId} failed, will retry:`, error);
    return false;
  }
}
