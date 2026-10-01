import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ModelRoleConfig } from '../src/config.js';
import { ModelStore, registryPath } from '../src/models/registry.js';

const roles = (
  overrides: Partial<Record<'planner' | 'vision' | 'fast', Partial<ModelRoleConfig>>> = {},
): Record<'planner' | 'vision' | 'fast', ModelRoleConfig> => ({
  planner: { role: 'planner', provider: 'openai-compatible', model: 'gpt-4.1', apiKey: 'sk-a', baseUrl: 'http://a/v1', ...overrides.planner },
  vision: { role: 'vision', provider: 'openai-compatible', model: 'gpt-4.1', apiKey: 'sk-a', baseUrl: 'http://a/v1', ...overrides.vision },
  fast: { role: 'fast', provider: 'openai-compatible', model: 'gpt-4.1', apiKey: 'sk-a', baseUrl: 'http://a/v1', ...overrides.fast },
});

describe('model store', () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'studio-models-'));
    file = join(dir, 'models.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds roles that point at the same model as one profile', () => {
    // Three env vars naming one model *are* one model; listing it three times
    // would suggest it can be edited independently when it cannot.
    const store = new ModelStore(file, roles());
    expect(store.list().profiles).toHaveLength(1);
    expect(store.list().roles).toEqual({ planner: 'env-1', vision: 'env-1', fast: 'env-1' });
  });

  it('seeds separate profiles when the roles differ', () => {
    const store = new ModelStore(file, roles({ fast: { model: 'gpt-4.1-mini' } }));
    expect(store.list().profiles).toHaveLength(2);
  });

  it('never hands the key back to the caller', () => {
    const store = new ModelStore(file, roles());
    const serialised = JSON.stringify(store.publicView());
    expect(serialised).not.toContain('sk-a');
    expect(store.publicView().profiles[0]?.hasApiKey).toBe(true);
  });

  it('keeps the key on disk so a restart does not lose it', () => {
    new ModelStore(file, roles());
    expect(readFileSync(file, 'utf8')).toContain('sk-a');
  });

  it('resolves a role to the profile it points at', () => {
    const store = new ModelStore(file, roles());
    expect(store.resolveRole('planner')).toMatchObject({ provider: 'openai-compatible', model: 'gpt-4.1', apiKey: 'sk-a' });
  });

  it('returns null for a role sent back to the offline engine', () => {
    const store = new ModelStore(file, roles());
    store.assign('planner', null);
    expect(store.resolveRole('planner')).toBeNull();
  });

  it('carries a profile’s own token ceiling through to the gateway config', () => {
    // Reasoning models need more than the deployment default, and a stored
    // ceiling that never reaches the gateway is a field that lies.
    const store = new ModelStore(file, roles());
    store.add({ label: 'reasoner', provider: 'openai-compatible', model: 'big', apiKey: 'k', maxTokens: 12000 });
    const id = store.list().profiles.at(-1)!.id;
    expect(store.resolveProfile(id)).toMatchObject({ model: 'big', maxTokens: 12000 });
  });

  it('refuses to delete a model a role still uses, and names the roles', () => {
    const store = new ModelStore(file, roles());
    expect(() => store.remove('env-1')).toThrow(/assigned to planner, vision, fast/);
    expect(store.list().profiles).toHaveLength(1);
  });

  it('deletes once the model is unreferenced', () => {
    const store = new ModelStore(file, roles());
    for (const role of ['planner', 'vision', 'fast'] as const) store.assign(role, null);
    store.remove('env-1');
    expect(store.list().profiles).toHaveLength(0);
  });

  it('keeps the stored key when an edit leaves the key field blank', () => {
    // The browser only ever learns whether a key exists, so an empty field on
    // save means "I did not retype it" and must not erase the credential.
    const store = new ModelStore(file, roles());
    store.update('env-1', { label: 'Renamed', apiKey: '' });
    expect(store.resolveRole('planner')).toMatchObject({ apiKey: 'sk-a' });
    expect(store.publicView().profiles[0]?.label).toBe('Renamed');
  });

  it('replaces the key when a new one is supplied', () => {
    const store = new ModelStore(file, roles());
    store.update('env-1', { apiKey: 'sk-new' });
    expect(store.resolveRole('planner')).toMatchObject({ apiKey: 'sk-new' });
  });

  it('survives a restart', () => {
    const store = new ModelStore(file, roles());
    store.add({ label: 'second', provider: 'anthropic', model: 'claude' });
    const reopened = new ModelStore(file, roles());
    expect(reopened.list().profiles.map((p) => p.label).sort()).toEqual(['openai-compatible/gpt-4.1', 'second']);
  });

  it('drops a role reference to a profile that is gone', () => {
    // Hand-edited or truncated on disk. Silently resolving that role to the
    // offline engine would be indistinguishable from a deliberate choice.
    writeFileSync(file, JSON.stringify({ profiles: [], roles: { planner: 'ghost', vision: null, fast: null } }));
    const store = new ModelStore(file, roles());
    expect(store.list().roles.planner).toBeNull();
  });

  it('rejects assigning a role to an unknown profile', () => {
    const store = new ModelStore(file, roles());
    expect(() => store.assign('planner', 'nope')).toThrow(/No model profile/);
  });

  it('refuses a duplicate id rather than shadowing the existing model', () => {
    const store = new ModelStore(file, roles());
    expect(() => store.add({ id: 'env-1', label: 'impostor', provider: 'mock', model: 'x' })).toThrow(/already exists/);
  });

  it('writes the registry atomically', () => {
    // A half-written models.json is read back on the next start and takes the
    // ability to plan anything with it.
    const store = new ModelStore(file, roles());
    store.add({ label: 'x', provider: 'mock', model: 'y' });
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });
});

describe('registryPath', () => {
  it('keeps the registry inside the orchestrator data dir', () => {
    const path = registryPath({ dataDir: join('/tmp', 'data-x') } as never);
    expect(path).toBe(join('/tmp', 'data-x', 'models.json'));
  });
});