import { createHash, randomUUID } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const { JOBS_TABLE, TEAMS_TABLE, BUCKET, SAST_QUEUE_URL, PENTEST_QUEUE_URL } = process.env;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' });
const sqs = new SQSClient({});
const URL_LIFETIME_SECONDS = 900;

const ifStillAllowed = async (update) => {
  try {
    await update;
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
};

const awsDeps = {
  now: () => new Date().toISOString(),
  getTeam: async (apiKeyHash) =>
    (await db.send(new GetCommand({ TableName: TEAMS_TABLE, Key: { apiKeyHash } }))).Item,
  getJob: async (teamId, jobId) =>
    (await db.send(new GetCommand({ TableName: JOBS_TABLE, Key: { teamId, jobId } }))).Item,
  putJob: (job) => db.send(new PutCommand({ TableName: JOBS_TABLE, Item: job })),

  setStatus: (teamId, jobId, from, to) =>
    ifStillAllowed(db.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { teamId, jobId },
      UpdateExpression: 'SET #s = :to, updatedAt = :now',
      ConditionExpression: '#s = :from',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':from': from, ':to': to, ':now': new Date().toISOString() },
    }))),
  listJobs: async (teamId) =>
    (await db.send(new QueryCommand({
      TableName: JOBS_TABLE,
      KeyConditionExpression: 'teamId = :t',
      ExpressionAttributeValues: { ':t': teamId },
      ConsistentRead: true,
    }))).Items || [],
  enqueue: (scanType, message) =>
    sqs.send(new SendMessageCommand({
      QueueUrl: scanType === 'SAST' ? SAST_QUEUE_URL : PENTEST_QUEUE_URL,
      MessageBody: JSON.stringify(message),
    })),
  objectExists: async (Key) => {
    try {
      await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key }));
      return true;
    } catch (error) {
      if (error.$metadata?.httpStatusCode === 404) return false;
      throw error;
    }
  },
  presignUpload: (Key) =>
    getSignedUrl(s3, new PutObjectCommand({ Bucket: BUCKET, Key }), { expiresIn: URL_LIFETIME_SECONDS }),
};

export const hashKey = (key) => createHash('sha256').update(key).digest('hex');

const reply = (statusCode, body) => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function authenticate(event, deps) {
  const key = event.headers?.['x-api-key'];
  if (!key) return null;
  return deps.getTeam(hashKey(key));
}

// A team can have max 3 jobs queued or running at once, so that a single team don't fill the queue.
export const MAX_ACTIVE_JOBS = 3;
const ACTIVE = ['QUEUED', 'RUNNING'];

async function overLimit(teamId, deps) {
  const jobs = await deps.listJobs(teamId);
  return jobs.filter((j) => ACTIVE.includes(j.status)).length >= MAX_ACTIVE_JOBS;
}

const tooMany = () => reply(429, { error: `Your team already has ${MAX_ACTIVE_JOBS} jobs queued or running. Try again when one finishes.` });

const parseBody = (event) => {
  try {
    return JSON.parse(event.body || '{}');
  } catch {
    return null;
  }
};

export async function createJob(event, deps = awsDeps) {
  const team = await authenticate(event, deps);
  if (!team) return reply(401, { error: 'Missing or invalid x-api-key' });

  const body = parseBody(event);
  if (!body) return reply(400, { error: 'Body must be JSON' });

  const jobId = randomUUID();
  const job = { teamId: team.teamId, jobId, scanType: body.scanType, createdAt: deps.now() };

  if (body.scanType === 'SAST') {
    const uploadKey = `uploads/${team.teamId}/${jobId}.zip`;
    await deps.putJob({ ...job, status: 'WAITING_FOR_UPLOAD', uploadKey });
    const uploadUrl = await deps.presignUpload(uploadKey);
    return reply(201, { jobId, status: 'WAITING_FOR_UPLOAD', uploadUrl });
  }

  if (body.scanType === 'PENTEST') {
    let url;
    try {
      url = new URL(body.targetUrl);
    } catch {
      return reply(400, { error: 'targetUrl must be a valid URL' });
    }
    if (!['http:', 'https:'].includes(url.protocol)) {
      return reply(400, { error: 'targetUrl must use http or https' });
    }
    // Team can only scan hosts they registered
    if (!(team.allowedTargets || []).includes(url.host)) {
      return reply(403, { error: `Host ${url.host} is not registered for this team` });
    }
    if (await overLimit(team.teamId, deps)) return tooMany();
    await deps.putJob({ ...job, status: 'QUEUED', targetUrl: url.href });
    await deps.enqueue('PENTEST', { teamId: team.teamId, jobId });
    return reply(202, { jobId, status: 'QUEUED' });
  }

  return reply(400, { error: 'scanType must be SAST or PENTEST' });
}

export async function startJob(event, deps = awsDeps) {
  const team = await authenticate(event, deps);
  if (!team) return reply(401, { error: 'Missing or invalid x-api-key' });

  const jobId = event.pathParameters?.jobId;
  const job = await deps.getJob(team.teamId, jobId);
  if (!job) return reply(404, { error: 'Job not found' });
  if (job.status !== 'WAITING_FOR_UPLOAD') {
    return reply(409, { error: `Job is already ${job.status}` });
  }
  if (!(await deps.objectExists(job.uploadKey))) {
    return reply(409, { error: 'Upload the zip first' });
  }
  if (await overLimit(team.teamId, deps)) return tooMany();
  // Conditional update to prevent double-queueing if two requests arrive at the same time
  if (!(await deps.setStatus(team.teamId, jobId, 'WAITING_FOR_UPLOAD', 'QUEUED'))) {
    return reply(409, { error: 'Job was already started' });
  }
  await deps.enqueue('SAST', { teamId: team.teamId, jobId });
  return reply(202, { jobId, status: 'QUEUED' });
}

export const handler = (event) =>
  (event.pathParameters?.jobId ? startJob : createJob)(event);
