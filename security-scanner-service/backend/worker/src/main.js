// SQS polling loop: picks up one job at a time, runs it, deletes it on success.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { SQSClient, ReceiveMessageCommand, DeleteMessageCommand, ChangeMessageVisibilityCommand } from '@aws-sdk/client-sqs';
import { processJob } from './process.js';
import { scanZip, scanTarget } from './scan.js';

const { QUEUE_URL, JOBS_TABLE, BUCKET, AWS_REGION = 'us-east-1' } = process.env;
const db = DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }));
const s3 = new S3Client({ region: AWS_REGION });
const sqs = new SQSClient({ region: AWS_REGION });

const update = async (teamId, jobId, from, fields) => {
  const names = Object.keys(fields);
  try {
    await db.send(new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { teamId, jobId },
      UpdateExpression: `SET ${names.map((n, i) => `#k${i} = :v${i}`).join(', ')}`,
      ConditionExpression: `#status IN (${from.map((_, i) => `:from${i}`).join(', ')})`,
      ExpressionAttributeNames: { '#status': 'status', ...Object.fromEntries(names.map((n, i) => [`#k${i}`, n])) },
      ExpressionAttributeValues: {
        ...Object.fromEntries(from.map((f, i) => [`:from${i}`, f])),
        ...Object.fromEntries(names.map((n, i) => [`:v${i}`, fields[n]])),
      },
    }));
    return true;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return false;
    throw error;
  }
};

const store = {
  getJob: async (teamId, jobId) =>
    (await db.send(new GetCommand({ TableName: JOBS_TABLE, Key: { teamId, jobId } }))).Item,
  // RUNNING -> RUNNING is allowed, because SQS hands a job to a new worker if the last one died.
  markRunning: (teamId, jobId) =>
    update(teamId, jobId, ['QUEUED', 'RUNNING'], { status: 'RUNNING', startedAt: new Date().toISOString() }),
  markCompleted: (teamId, jobId, reportKey, summary) =>
    update(teamId, jobId, ['RUNNING'], { status: 'COMPLETED', reportKey, summary, finishedAt: new Date().toISOString() }),
  markFailed: (teamId, jobId, error) =>
    update(teamId, jobId, ['QUEUED', 'RUNNING'], { status: 'FAILED', error, finishedAt: new Date().toISOString() }),
  readUpload: async (Key) => {
    const { Body } = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key }));
    return Buffer.from(await Body.transformToByteArray());
  },
  writeReport: (Key, report) =>
    s3.send(new PutObjectCommand({
      Bucket: BUCKET, Key, Body: JSON.stringify(report, null, 2), ContentType: 'application/json',
    })),
};

// Reset visibility every 2 min so SQS doesn't hand the job to another worker in mid-scan
const VISIBILITY_SECONDS = 300;
const HEARTBEAT_MS = 120 * 1000;

const keepHidden = (ReceiptHandle) => setInterval(() => {
  sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: QUEUE_URL, ReceiptHandle, VisibilityTimeout: VISIBILITY_SECONDS }))
    .catch((error) => console.error('Could not extend the message timeout:', error));
}, HEARTBEAT_MS);

console.log(`Worker started, polling ${QUEUE_URL}`);
for (;;) {
  try {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl: QUEUE_URL, MaxNumberOfMessages: 1, WaitTimeSeconds: 20,
    }));
    for (const message of Messages) {
      const heartbeat = keepHidden(message.ReceiptHandle);
      try {
        const job = JSON.parse(message.Body);
        console.log(JSON.stringify({ event: 'job_received', ...job }));
        const finished = await processJob(job, store, { scanZip, scanTarget });
        console.log(JSON.stringify({ event: finished ? 'job_finished' : 'job_will_retry', ...job }));
        if (finished) {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: message.ReceiptHandle }));
        }
      } finally {
        clearInterval(heartbeat);
      }
    }
  } catch (error) {
    console.error('Polling error:', error);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}
