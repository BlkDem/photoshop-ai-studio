import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { StudioException } from '@photoshop-ai-studio/shared';
import {
  MODEL_ROLES,
  type ModelProfile,
  type ModelProfileInput,
  type ModelProviderId,
  type ModelRegistry,
  type ModelRoleId,
} from '@photoshop-ai-studio/shared';
import type { ModelRoleConfig, OrchestratorConfig } from '../config.js';

/**
 * The set of LLMs a deployment can route to, and which one each role uses.
 *
 * Roles used to be read once from `.env` and fixed for the process lifetime, so
 * changing a model meant editing a file and restarting. That made "add a model"
 * a deployment action rather than a Studio action, and it is the reason a person
 * could not try a second provider without leaving the interface.
 *
 * The registry is seeded from the environment on first run, so an existing
 * `.env` keeps working untouched and shows up in the UI as an `env`-origin
 * profile that can be edited like any other. Secrets are stored here and never
 * leave the process: the API reports `hasApiKey`, and responses are built by
 * `toPublicProfile` so a key cannot reach the browser by accident.
 *
 * Writes go through a temp file and a rename. A half-written `models.json` would
 * be read back on the next start and would take the registry — and therefore the
 * ability to plan anything — with it.
 */
export class ModelStore {
  private state: ModelRegistry;

  constructor(
    private readonly file: string,
    seed: Record<ModelRoleId, ModelRoleConfig>,
  ) {
    mkdirSync(join(file, '..'), { recursive: true });
    this.state = readRegistry(file) ?? seedFromConfig(seed);
    this.persist();
  }

  list(): ModelRegistry {
    return this.state;
  }

  /** The public shape: profiles without their keys. */
  publicView(): { profiles: ModelProfile[]; roles: ModelRegistry['roles'] } {
    return {
      profiles: this.state.profiles.map(toPublicProfile),
      roles: { ...this.state.roles },
    };
  }

  private find(id: string): ModelProfile & { apiKey?: string } {
    const found = this.state.profiles.find((p) => p.id === id);
    if (!found) throw new StudioException('MODEL_UNAVAILABLE', `No model profile with id "${id}"`, { recoverable: false });
    return found as ModelProfile & { apiKey?: string };
  }

  /** Resolves an arbitrary profile by id, for probing a model no role uses. */
  resolveProfile(id: string): ModelRoleConfig | null {
    const profile = this.state.profiles.find((p) => p.id === id);
    if (!profile) return null;
    return {
      role: 'fast',
      provider: profile.provider,
      model: profile.model,
      apiKey: (profile as { apiKey?: string }).apiKey,
      baseUrl: profile.baseUrl ?? undefined,
      maxTokens: profile.maxTokens ?? undefined,
    };
  }

  /** Resolves a role to the config `createGateway` needs, or null for the offline engine. */
  resolveRole(role: ModelRoleId): ModelRoleConfig | null {
    const id = this.state.roles[role];
    if (!id) return null;
    const profile = this.state.profiles.find((p) => p.id === id);
    if (!profile) return null;
    return {
      role,
      provider: profile.provider,
      model: profile.model,
      apiKey: (profile as { apiKey?: string }).apiKey,
      baseUrl: profile.baseUrl ?? undefined,
      maxTokens: profile.maxTokens ?? undefined,
    };
  }

  add(input: ModelProfileInput): ModelProfile {
    const id = input.id?.trim() || `m-${randomUUID().slice(0, 8)}`;
    if (this.state.profiles.some((p) => p.id === id)) {
      throw new StudioException('INVALID_PARAMS', `A model with id "${id}" already exists`, { recoverable: false });
    }
    const profile = {
      id,
      label: input.label.trim(),
      provider: input.provider,
      model: input.model.trim(),
      baseUrl: input.baseUrl?.trim() || null,
      apiKey: input.apiKey?.trim() || undefined,
      hasApiKey: Boolean(input.apiKey?.trim()),
      maxTokens: input.maxTokens ?? null,
      origin: 'studio' as const,
    };
    this.state.profiles.push(profile);
    this.persist();
    return toPublicProfile(profile);
  }

  /** Applies a partial edit. Omitted fields keep their stored value. */
  update(id: string, patch: Partial<ModelProfileInput>): ModelProfile {
    const existing = this.find(id);
    const provider = patch.provider ?? existing.provider;
    const next: ModelProfile & { apiKey?: string } = {
      ...existing,
      provider,
      model: patch.model?.trim() ?? existing.model,
      label: patch.label?.trim() ?? existing.label,
      baseUrl: patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl.trim() || null,
      maxTokens: patch.maxTokens === undefined ? existing.maxTokens : patch.maxTokens,
      // An empty key means "leave it", not "erase it": the browser is only ever
      // told whether a key exists, so sending back an empty field would silently
      // delete a credential the operator cannot see.
      apiKey: patch.apiKey?.trim() ? patch.apiKey.trim() : existing.apiKey,
      hasApiKey: patch.apiKey?.trim() ? true : existing.hasApiKey,
    };
    this.state.profiles = this.state.profiles.map((p) => (p.id === id ? next : p));
    this.persist();
    return toPublicProfile(next);
  }

  remove(id: string): void {
    const assigned = MODEL_ROLES.filter((role) => this.state.roles[role] === id);
    if (assigned.length > 0) {
      throw new StudioException(
        'INVALID_PARAMS',
        `"${this.find(id).label}" is still assigned to ${assigned.join(', ')}. Point ${assigned.join(' and ')} at another model first.`,
        { recoverable: false },
      );
    }
    this.state.profiles = this.state.profiles.filter((p) => p.id !== id);
    this.persist();
  }

  assign(role: ModelRoleId, profileId: string | null): void {
    if (profileId !== null && !this.state.profiles.some((p) => p.id === profileId)) {
      throw new StudioException('MODEL_UNAVAILABLE', `No model profile with id "${profileId}"`, { recoverable: false });
    }
    this.state.roles[role] = profileId;
    this.persist();
  }

  private persist(): void {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(this.state, null, 2)}\n`, 'utf8');
    renameSync(tmp, this.file);
  }
}

/** Drops the credential; everything the Studio needs stays. */
function toPublicProfile(profile: ModelProfile & { apiKey?: string }): ModelProfile {
  const { apiKey: _apiKey, ...rest } = profile;
  return { ...rest, hasApiKey: Boolean(apiKeyPresent(profile)) };
}

function apiKeyPresent(profile: ModelProfile & { apiKey?: string }): string | undefined {
  return (profile as { apiKey?: string }).apiKey ?? (profile.hasApiKey ? 'configured' : undefined);
}

function readRegistry(file: string): ModelRegistry | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as ModelRegistry;
    if (!Array.isArray(parsed.profiles)) return null;
    // An id referenced by a role but missing from profiles would resolve that
    // role to the offline engine without saying so; drop the dangling reference.
    const known = new Set(parsed.profiles.map((p) => p.id));
    for (const role of MODEL_ROLES) {
      if (parsed.roles[role] && !known.has(parsed.roles[role]!)) parsed.roles[role] = null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Builds the first registry from the environment.
 *
 * Roles configured identically (two env vars pointing at one model) become one
 * profile, because they *are* one model — showing the same model twice would
 * suggest it can be edited independently when it cannot.
 */
function seedFromConfig(roles: Record<ModelRoleId, ModelRoleConfig>): ModelRegistry {
  const profiles: (ModelProfile & { apiKey?: string })[] = [];
  const byFingerprint = new Map<string, string>();
  const assigned: ModelRegistry['roles'] = { planner: null, vision: null, fast: null };

  for (const role of MODEL_ROLES) {
    const config = roles[role];
    const fingerprint = [config.provider, config.model, config.baseUrl ?? '', config.apiKey ?? ''].join(' ');
    let id = byFingerprint.get(fingerprint);
    if (!id) {
      id = `env-${profiles.length + 1}`;
      byFingerprint.set(fingerprint, id);
      profiles.push({
        id,
        label: `${config.provider}/${config.model}`,
        provider: config.provider,
        model: config.model,
        baseUrl: config.baseUrl ?? null,
        apiKey: config.apiKey,
        hasApiKey: Boolean(config.apiKey),
        maxTokens: null,
        origin: 'env' as const,
      });
    }
    assigned[role] = id;
  }

  return { profiles, roles: assigned };
}

/** Path the registry is stored at, derived from the orchestrator data dir. */
export function registryPath(config: OrchestratorConfig): string {
  return join(config.dataDir, 'models.json');
}

export type { ModelProviderId };