import { envInt } from '@photoshop-ai-studio/shared/node';
import { AnthropicGateway } from './anthropic.js';
import { DeterministicGateway } from './deterministic.js';
import { OpenAiCompatibleGateway } from './openai-compatible.js';
import { ModelUnavailableError, type ModelGateway, type ModelRole } from './types.js';
import type { ModelRoleConfig, OrchestratorConfig } from '../config.js';
import type { Logger } from '@photoshop-ai-studio/shared/node';

/**
 * Provider selection. The only place in the codebase that names a vendor.
 *
 * Adding a provider = one case here + one gateway file. The rest of the
 * Orchestrator depends on `ModelGateway` and never learns which one it got.
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-compatible': 'http://localhost:11434/v1',
  anthropic: 'https://api.anthropic.com/v1',
  mock: '',
};

export function createGateway(roleConfig: ModelRoleConfig, config: OrchestratorConfig, logger: Logger): ModelGateway {
  const timeoutMs = envInt('MODEL_TIMEOUT_MS', 60_000);
  const baseUrl = roleConfig.baseUrl ?? DEFAULT_BASE_URLS[roleConfig.provider] ?? '';
  // A profile's own ceiling wins: it was set because that model needs it.
  const maxTokens = roleConfig.maxTokens ?? config.maxTokens;

  switch (roleConfig.provider) {
    case 'mock':
      return new DeterministicGateway(roleConfig.role, roleConfig.model);

    case 'openai':
    case 'openai-compatible':
      return new OpenAiCompatibleGateway({
        role: roleConfig.role,
        model: roleConfig.model,
        apiKey: roleConfig.apiKey,
        baseUrl,
        temperature: config.temperature,
        timeoutMs,
        maxTokens,
        logger,
      });

    case 'anthropic':
      return new AnthropicGateway({
        role: roleConfig.role,
        model: roleConfig.model,
        apiKey: roleConfig.apiKey,
        baseUrl,
        temperature: config.temperature,
        timeoutMs,
        maxTokens,
      });

    default:
      throw new ModelUnavailableError(`Unknown provider "${roleConfig.provider}"`, roleConfig.provider, roleConfig.model);
  }
}

/** True when a gateway can actually reach a model (i.e. not the offline stub). */
export function isOnline(gateway: ModelGateway): boolean {
  return gateway.provider !== 'mock';
}

export function describeGateway(gateway: ModelGateway): string {
  return `${gateway.provider}/${gateway.model}`;
}

export type { ModelRole, ModelGateway };
