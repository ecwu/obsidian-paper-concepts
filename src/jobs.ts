import type { Job, Phase } from './types';

const PENDING: readonly Phase[] = ['queued', 'interrupted'];
const FINISHED: readonly Phase[] = ['succeeded', 'failed', 'cancelled'];
const RETRYABLE: readonly Phase[] = ['failed', 'cancelled'];

/** Waiting for the queue: either never started or stopped by shutdown. */
export const isPending = (job: Job): boolean => PENDING.includes(job.phase);
export const isFinished = (job: Job): boolean => FINISHED.includes(job.phase);
/** Neither pending nor finished: the process stopped while the job was mid-pipeline. */
export const wasInFlight = (job: Job): boolean => !isPending(job) && !isFinished(job);
export const canRetry = (job: Job): boolean => RETRYABLE.includes(job.phase);
