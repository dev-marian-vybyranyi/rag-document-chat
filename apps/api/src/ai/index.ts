import type { Env } from '../config/env.js';
import type { AiProvider } from './provider.js';
import { createGoogleProvider, type GoogleProviderEnv } from './providers/google.js';

export type { AiProvider, ChatModelConfig } from './provider.js';

export type AiEnv = GoogleProviderEnv & Pick<Env, 'AI_PROVIDER'>;

export function createAiProvider(env: AiEnv): AiProvider {
  switch (env.AI_PROVIDER) {
    case 'google':
      return createGoogleProvider(env);
  }
}
