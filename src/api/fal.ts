/**
 * fal.ai API client configuration and helpers.
 * All fal model calls from the app should go through this module.
 */
import { fal } from "@fal-ai/client";

const FAL_KEY = import.meta.env.VITE_FAL_KEY;

if (FAL_KEY) {
  fal.config({
    credentials: FAL_KEY,
  });
} else if (import.meta.env.DEV) {
  console.warn(
    "VITE_FAL_KEY is not set. Create a .env file with VITE_FAL_KEY=your_key. Get a key at https://fal.ai/dashboard/keys"
  );
}

export { fal };

/** Input for fal models must be a plain object. */
type FalInput = Record<string, unknown>;

/**
 * Run a fal model once and return the result.
 * Use for simple request/response (e.g. image generation, completion).
 */
export async function runFalModel<TInput extends FalInput, TOutput>(
  model: string,
  input: TInput
): Promise<TOutput> {
  const result = await fal.run(model, { input });
  return result.data as TOutput;
}

/**
 * Run a fal model with queue updates (e.g. progress, status).
 * Use when you need to show progress or handle long-running jobs.
 */
export async function subscribeFalModel<TInput extends FalInput, TOutput>(
  model: string,
  input: TInput,
  options?: {
    logs?: boolean;
    onQueueUpdate?: (status: { status: string }) => void;
  }
): Promise<TOutput> {
  const result = await fal.subscribe(model, {
    input,
    logs: options?.logs ?? false,
    onQueueUpdate: options?.onQueueUpdate,
  });
  return result.data as TOutput;
}

/**
 * Stream partial results from a fal model.
 * Use for token-by-token or chunked responses (e.g. LLM text).
 * Returns a stream object; iterate or subscribe to events for output.
 */
export async function streamFalModel<TInput extends FalInput, TOutput>(
  model: string,
  input: TInput,
  options?: { timeout?: number; signal?: AbortSignal }
) {
  const stream = await fal.stream(model, {
    input,
    timeout: options?.timeout,
    signal: options?.signal,
  });
  return stream as AsyncIterable<TOutput>;
}
