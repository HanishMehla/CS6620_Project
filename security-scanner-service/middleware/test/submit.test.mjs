import test from 'node:test';
import assert from 'node:assert/strict';
import { createJob, startJob, hashKey, MAX_ACTIVE_JOBS } from '../lamdas/submit/submit.mjs';

function fakeDeps() {
  const teams = {
    [hashKey('key-a')]: { teamId: 'team-a', allowedTargets: ['target.example:4000'] },
    [hashKey('key-b')]: { teamId: 'team-b', allowedTargets: [] },
  };
  const jobs = new Map();
  const queued = [];
  const objects = new Set();
  return {
    queued, objects, jobs,
    now: () => '2026-10-31T00:00:00.000Z',
    getTeam: async (h) => teams[h],
    getJob: async (t, j) => jobs.get(`${t}/${j}`),
    putJob: async (job) => { jobs.set(`${job.teamId}/${job.jobId}`, job); },
    setStatus: async (t, j, from, to) => {
      const job = jobs.get(`${t}/${j}`);
      if (!job || job.status !== from) return false;
      job.status = to;
      return true;
    },
    listJobs: async (t) => [...jobs.values()].filter((j) => j.teamId === t),
    enqueue: async (type, msg) => { queued.push({ type, ...msg }); },
    objectExists: async (k) => objects.has(k),
    presignUpload: async (k) => `https://upload/${k}`,
  };
}
const request = (key, body, jobId) => ({
  headers: key ? { 'x-api-key': key } : {},
  body: body && JSON.stringify(body),
  pathParameters: jobId ? { jobId } : undefined,
});
const json = (res) => JSON.parse(res.body);

test('rejects a request with no key or a wrong key', async () => {
  const deps = fakeDeps();
  assert.equal((await createJob(request(null, { scanType: 'SAST' }), deps)).statusCode, 401);
  assert.equal((await createJob(request('nope', { scanType: 'SAST' }), deps)).statusCode, 401);
});

test('rejects an unknown scan type', async () => {
  assert.equal((await createJob(request('key-a', { scanType: 'X' }), fakeDeps())).statusCode, 400);
});

test('SAST job waits for the upload, then queues on start', async () => {
  const deps = fakeDeps();
  const created = await createJob(request('key-a', { scanType: 'SAST' }), deps);
  assert.equal(created.statusCode, 201);
  const { jobId, uploadUrl } = json(created);
  assert.match(uploadUrl, /uploads\/team-a\//);

  assert.equal((await startJob(request('key-a', null, jobId), deps)).statusCode, 409);
  assert.equal(deps.queued.length, 0);

  deps.objects.add(`uploads/team-a/${jobId}.zip`);
  assert.equal((await startJob(request('key-a', null, jobId), deps)).statusCode, 202);
  assert.deepEqual(deps.queued, [{ type: 'SAST', teamId: 'team-a', jobId }]);
  assert.equal((await startJob(request('key-a', null, jobId), deps)).statusCode, 409);
});

test('pentest only runs against a host registered to the team', async () => {
  const deps = fakeDeps();
  const ok = await createJob(request('key-a', { scanType: 'PENTEST', targetUrl: 'http://target.example:4000/api/users' }), deps);
  assert.equal(ok.statusCode, 202);
  assert.equal(deps.queued[0].type, 'PENTEST');

  const other = await createJob(request('key-a', { scanType: 'PENTEST', targetUrl: 'http://169.254.169.254/latest' }), deps);
  assert.equal(other.statusCode, 403);
  const wrongTeam = await createJob(request('key-b', { scanType: 'PENTEST', targetUrl: 'http://target.example:4000/' }), deps);
  assert.equal(wrongTeam.statusCode, 403);
  const badScheme = await createJob(request('key-a', { scanType: 'PENTEST', targetUrl: 'file:///etc/passwd' }), deps);
  assert.equal(badScheme.statusCode, 400);
  assert.equal(deps.queued.length, 1);
});

test('one team cannot start another team\'s job', async () => {
  const deps = fakeDeps();
  const { jobId } = json(await createJob(request('key-a', { scanType: 'SAST' }), deps));
  deps.objects.add(`uploads/team-a/${jobId}.zip`);
  assert.equal((await startJob(request('key-b', null, jobId), deps)).statusCode, 404);
  assert.equal(deps.queued.length, 0);
});

test('a team can only have 3 jobs queued or running at once', async () => {
  const deps = fakeDeps();
  const pentest = () => createJob(request('key-a', { scanType: 'PENTEST', targetUrl: 'http://target.example:4000/' }), deps);
  for (let i = 0; i < MAX_ACTIVE_JOBS; i += 1) assert.equal((await pentest()).statusCode, 202);
  assert.equal((await pentest()).statusCode, 429);

  // A SAST job can be created, but not started while the team is at the limit.
  const { jobId } = json(await createJob(request('key-a', { scanType: 'SAST' }), deps));
  deps.objects.add(`uploads/team-a/${jobId}.zip`);
  assert.equal((await startJob(request('key-a', null, jobId), deps)).statusCode, 429);

  // Another team is not affected.
  deps.jobs.set('team-b/x', { teamId: 'team-b', jobId: 'x', status: 'WAITING_FOR_UPLOAD', uploadKey: 'k' });
  deps.objects.add('k');
  assert.equal((await startJob(request('key-b', null, 'x'), deps)).statusCode, 202);

  // Once a job finishes, the team can queue again.
  [...deps.jobs.values()].find((j) => j.teamId === 'team-a' && j.status === 'QUEUED').status = 'COMPLETED';
  assert.equal((await pentest()).statusCode, 202);
});
