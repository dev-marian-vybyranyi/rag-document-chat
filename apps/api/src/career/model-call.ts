import { generateText, Output, type LanguageModel } from 'ai';
import type { z } from 'zod';

export const DEFAULT_PROFILE_TIMEOUT_MS = 90_000;

type ProviderOptions = NonNullable<Parameters<typeof generateText>[0]['providerOptions']>;

export interface StructuredCall<Schema extends z.ZodType> {
  model: LanguageModel;
  system: string;
  prompt: string;
  schema: Schema;
  maxOutputTokens: number;
  providerOptions?: ProviderOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function generateStructured<Schema extends z.ZodType>({
  model,
  system,
  prompt,
  schema,
  maxOutputTokens,
  providerOptions,
  signal,
  timeoutMs = DEFAULT_PROFILE_TIMEOUT_MS,
}: StructuredCall<Schema>): Promise<z.infer<Schema>> {
  const timeout = AbortSignal.timeout(timeoutMs);
  const { output } = await generateText({
    model,
    system,
    prompt,
    output: Output.object({ schema }),
    temperature: 0,
    maxOutputTokens,
    maxRetries: 1,
    providerOptions,
    abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  return output as z.infer<Schema>;
}

export type { ProviderOptions };
