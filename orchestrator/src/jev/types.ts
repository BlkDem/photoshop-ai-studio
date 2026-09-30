import type { DocumentSnapshot } from '@photoshop-ai-studio/shared';
import type { PlanDraft } from '../gateway/types.js';

/**
 * JEV integration boundary (§16).
 *
 * JEV is the fast path: it turns a short, unambiguous instruction into a plan
 * without calling a model, which removes latency and cost from the most common
 * requests ("rename Logo to Company Logo", "set opacity to 70%", "hide
 * Background"). Two implementations exist behind one interface:
 *
 *  - `DeterministicJevRouter` — a grammar/rule engine that ships with the repo.
 *    No runtime, no network, fully unit-tested.
 *  - `RemoteJevRouter` — posts to a real JEV runtime when `JEV_RUNTIME_URL` is
 *    set. The Orchestrator code path is byte-for-byte identical; only the router
 *    changes. That is the point of the interface.
 *
 * A router that is unsure must return `{ kind: 'llm' }`. Guessing on the fast
 * path is worse than being slow, because a wrong fast path executes without
 * asking the model and often without asking the user.
 */
export type JevMode = 'deterministic' | 'remote' | 'disabled';

export interface JevInput {
  text: string;
  state: DocumentSnapshot | null;
}

export type JevDecision =
  | { kind: 'fast'; confidence: number; rule: string; draft: PlanDraft }
  | { kind: 'llm'; reason: string };

export interface JevRouter {
  readonly mode: JevMode;
  readonly runtimeUrl: string | null;
  route(input: JevInput): Promise<JevDecision>;
}

export class DisabledJevRouter implements JevRouter {
  readonly mode = 'disabled' as const;
  readonly runtimeUrl = null;

  async route(): Promise<JevDecision> {
    return { kind: 'llm', reason: 'JEV fast path disabled' };
  }
}
