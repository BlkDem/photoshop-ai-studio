import { envBool, envInt } from '@photoshop-ai-studio/shared/node';
import type { Logger } from '@photoshop-ai-studio/shared/node';
import { DeterministicJevRouter } from './deterministic.js';
import { RemoteJevRouter } from './remote.js';
import { DisabledJevRouter } from './types.js';
import type { JevRouter } from './types.js';
import type { OrchestratorConfig } from '../config.js';

export * from './types.js';
export { DeterministicJevRouter } from './deterministic.js';
export { RemoteJevRouter } from './remote.js';

/**
 * Selects the JEV implementation from configuration.
 *
 * `JEV_RUNTIME_URL` set → the real runtime. Unset → the built-in deterministic
 * engine. `JEV_ENABLED=false` → disabled, everything goes to the model. The
 * Orchestrator itself cannot tell the difference.
 */
export function createJevRouter(config: OrchestratorConfig, logger: Logger): JevRouter {
  if (!envBool('JEV_ENABLED', true)) {
    logger.info({ event: 'jev.route', message: 'JEV fast path disabled via JEV_ENABLED=false' });
    return new DisabledJevRouter();
  }
  if (config.jevRuntimeUrl) {
    logger.info({ event: 'jev.route', message: `JEV fast path: remote runtime at ${config.jevRuntimeUrl}` });
    return new RemoteJevRouter({
      url: config.jevRuntimeUrl,
      apiKey: config.jevRuntimeApiKey,
      minConfidence: config.jevMinConfidence,
      timeoutMs: envInt('JEV_TIMEOUT_MS', 5_000),
      logger,
    });
  }
  logger.info({
    event: 'jev.route',
    message: `JEV fast path: built-in deterministic engine (min confidence ${config.jevMinConfidence})`,
  });
  return new DeterministicJevRouter(config.jevMinConfidence);
}
