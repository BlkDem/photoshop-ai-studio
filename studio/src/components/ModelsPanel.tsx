import { useCallback, useEffect, useState } from 'react';

import type { ModelProfile, ModelProfileInput, ModelProviderId, ModelRegistry, ModelRoleId } from '@photoshop-ai-studio/shared';
import { api, ApiError } from '../api/client.js';

export interface ModelsPanelProps {
  onClose: () => void;
}

const PROVIDERS: { id: ModelProviderId; label: string; hint: string }[] = [
  { id: 'openai', label: 'OpenAI', hint: 'api.openai.com by default' },
  { id: 'openai-compatible', label: 'OpenAI-compatible', hint: 'OpenRouter, Groq, LM Studio, vLLM, Ollama, a local gateway' },
  { id: 'anthropic', label: 'Anthropic', hint: 'Messages API' },
  { id: 'mock', label: 'Offline engine', hint: 'Deterministic JEV engine, no model' },
];

const ROLES: { id: ModelRoleId; label: string; blurb: string }[] = [
  { id: 'planner', label: 'Planner', blurb: 'writes the step list' },
  { id: 'vision', label: 'Verifier', blurb: 'judges the finished result' },
  { id: 'fast', label: 'Chat', blurb: 'one-line replies' },
];

type Registry = Pick<ModelRegistry, 'profiles' | 'roles'>;

const BLANK: ModelProfileInput = { label: '', provider: 'openai-compatible', model: '', baseUrl: '', apiKey: '' };

/**
 * Add, remove and route LLMs.
 *
 * The orchestrator owns the credentials, so this form sends a key and never
 * receives one back — a profile arrives with `hasApiKey` and no way to read it.
 * That is why editing leaves the key field blank rather than showing something
 * that cannot be shown: submitting an empty field keeps the stored key.
 */
export function ModelsPanel({ onClose }: ModelsPanelProps): React.JSX.Element {
  const [registry, setRegistry] = useState<Registry | null>(null);
  const [draft, setDraft] = useState<ModelProfileInput>(BLANK);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [probes, setProbes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setRegistry(await api.models());
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (action: () => Promise<unknown>, successNote?: string): Promise<void> => {
    setBusy(true);
    try {
      await action();
      setError(null);
      if (successNote) setNote(successNote);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const payload: ModelProfileInput = { ...draft, label: draft.label.trim() || draft.model.trim() };
    if (editing) {
      void run(() => api.updateModel(editing, payload), `Updated "${payload.label}"`);
      setEditing(null);
      setDraft(BLANK);
      return;
    }
    void run(() => api.addModel(payload), `Added "${payload.label}"`);
    setDraft(BLANK);
  };

  const edit = (profile: ModelProfile): void => {
    setEditing(profile.id);
    // The key is deliberately empty: it is not readable, and leaving it blank
    // keeps the stored one rather than clearing it.
    setDraft({
      label: profile.label,
      provider: profile.provider,
      model: profile.model,
      baseUrl: profile.baseUrl ?? '',
      apiKey: '',
    });
  };

  const probe = (profile: ModelProfile): void => {
    setProbes((p) => ({ ...p, [profile.id]: 'checking…' }));
    void run(async () => {
      const result = await api.probeModel(profile.id);
      setProbes((p) => ({
        ...p,
        [profile.id]: result.ok ? `ok · ${result.latencyMs} ms · "${result.detail}"` : `failed · ${result.detail}`,
      }));
    });
  };

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Models">
      <div className="modal__panel">
        <header className="modal__head">
          <h2>Models</h2>
          <button type="button" className="btn btn--ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal__body">
          <section className="models__roles">
            {ROLES.map((role) => {
              const current = registry?.roles[role.id] ?? null;
              const profile = registry?.profiles.find((p) => p.id === current) ?? null;
              return (
                <div key={role.id} className="models__role">
                  <label className="models__role-label" htmlFor={`role-${role.id}`}>
                    <strong>{role.label}</strong>
                    <span>{role.blurb}</span>
                  </label>
                  <select
                    id={`role-${role.id}`}
                    className="input"
                    value={current ?? ''}
                    disabled={busy || !registry}
                    onChange={(event) => {
                      const next = event.target.value || null;
                      if (next) void run(() => api.assignModel(next, { role: role.id, profileId: next }));
                      else if (profile) {
                        void run(() => api.assignModel(profile.id, { role: role.id, profileId: null }), `${role.label} → offline engine`);
                      }
                    }}
                  >
                    <option value="">Offline engine (deterministic)</option>
                    {registry?.profiles.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>
              );
            })}
          </section>

          {error ? <p className="banner banner--error">{error}</p> : null}
          {note ? <p className="banner banner--ok">{note}</p> : null}

          <section className="models__list">
            {!registry ? <p className="empty">Loading…</p> : null}
            {registry?.profiles.map((profile) => {
              const inUse = ROLES.filter((r) => registry.roles[r.id] === profile.id).map((r) => r.label);
              return (
                <article key={profile.id} className="model">
                  <div className="model__main">
                    <div className="model__title">
                      <strong>{profile.label}</strong>
                      {inUse.length > 0 ? <span className="chip">{inUse.join(' · ')}</span> : null}
                      {profile.origin === 'env' ? <span className="chip chip--muted">from .env</span> : null}
                    </div>
                    <div className="model__meta">
                      <code>{profile.provider}</code> · <code>{profile.model}</code>
                      {profile.baseUrl ? <> · {profile.baseUrl}</> : null}
                      {profile.maxTokens ? <> · {profile.maxTokens} tokens</> : null}
                      {profile.hasApiKey ? <> · key set</> : <> · no key</>}
                    </div>
                    {probes[profile.id] ? <div className="model__probe">{probes[profile.id]}</div> : null}
                  </div>
                  <div className="model__actions">
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => probe(profile)}>
                      Test
                    </button>
                    <button type="button" className="btn btn--ghost" disabled={busy} onClick={() => edit(profile)}>
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost btn--danger"
                      disabled={busy}
                      title={inUse.length > 0 ? `Still used by ${inUse.join(', ')}` : 'Remove this model'}
                      onClick={() => void run(() => api.removeModel(profile.id), `Removed "${profile.label}"`)}
                    >
                      Remove
                    </button>
                  </div>
                </article>
              );
            })}
            {registry?.profiles.length === 0 ? (
              <p className="empty">
                No models yet. Every role is on the offline deterministic engine, which handles only the fixed commands it
                knows.
              </p>
            ) : null}
          </section>

          <form className="models__form" onSubmit={submit}>
            <h3>{editing ? 'Edit model' : 'Add a model'}</h3>
            <div className="models__grid">
              <label className="field">
                <span>Label</span>
                <input className="input" value={draft.label} placeholder="Space Bunny Alpha" onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </label>
              <label className="field">
                <span>Provider</span>
                <select className="input" value={draft.provider} onChange={(e) => setDraft({ ...draft, provider: e.target.value as ModelProviderId })}>
                  {PROVIDERS.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Model</span>
                <input
                  className="input"
                  value={draft.model}
                  placeholder="stealth/space-bunny-alpha"
                  onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                  required
                />
              </label>
              <label className="field">
                <span>Base URL</span>
                <input
                  className="input"
                  value={draft.baseUrl}
                  placeholder="https://openrouter.ai/api/v1"
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                />
              </label>
              <label className="field">
                <span>API key {editing ? '(blank keeps the stored one)' : ''}</span>
                <input
                  className="input"
                  type="password"
                  value={draft.apiKey}
                  autoComplete="off"
                  onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                />
              </label>
              <label className="field">
                <span>Token ceiling</span>
                <input
                  className="input"
                  type="number"
                  min={256}
                  value={draft.maxTokens ?? ''}
                  placeholder="8192"
                  onChange={(e) => setDraft({ ...draft, maxTokens: e.target.value ? Number(e.target.value) : undefined })}
                />
              </label>
            </div>
            <p className="models__hint">
              A reasoning model needs a high ceiling: it spends most of it before emitting JSON, and running out returns no
              plan at all rather than a short one.
            </p>
            <div className="models__form-actions">
              <button type="submit" className="btn btn--primary" disabled={busy || draft.model.trim() === ''}>
                {editing ? 'Save' : 'Add model'}
              </button>
              {editing ? (
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditing(null);
                    setDraft(BLANK);
                  }}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}