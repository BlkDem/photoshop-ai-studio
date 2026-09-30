import { useEffect, useRef, useState } from 'react';

import type { ChatMessage, ConfirmationRequest, Plan, Run } from '@photoshop-ai-studio/shared';

export interface ChatProps {
  messages: ChatMessage[];
  run: Run | null;
  busy: boolean;
  onSend: (text: string) => void;
  onApprove: (decisions: { stepId: string; approved: boolean }[]) => void;
  onCancel: () => void;
}

const SUGGESTIONS = [
  'Create a square version of this banner.',
  'Rename Logo to Company Logo',
  'Set the Title opacity to 70%',
  'Hide Background',
  'Export png',
  'Group the Logo and the Title into a Header',
  'Centre the Title',
];

const AWAITING_APPROVAL = new Set(['awaiting_approval', 'awaiting_confirmation']);

/** Right rail: the conversation and the approval surface (§20). */
export function Chat({ messages, run, busy, onSend, onApprove, onCancel }: ChatProps): React.JSX.Element {
  const [draft, setDraft] = useState('');
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  const submit = (): void => {
    if (!draft.trim() || busy) return;
    onSend(draft);
    setDraft('');
  };

  const canApprove = run !== null && AWAITING_APPROVAL.has(run.status);

  return (
    <aside className="chat">
      <div className="chat__scroll">
        {messages.length === 0 ? (
          <div className="chat__intro">
            <h2>Ask for a change</h2>
            <p>
              Studio reads the open document, proposes a plan, and only touches Photoshop after you approve it. Every
              step is verified against the resulting document state.
            </p>
            <ul className="chat__suggestions">
              {SUGGESTIONS.map((text) => (
                <li key={text}>
                  <button type="button" className="suggestion" onClick={() => onSend(text)} disabled={busy}>
                    {text}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {messages.map((message) => (
          <article key={message.id} className={`msg msg--${message.role} msg--${message.kind}`}>
            <p className="msg__text">{message.content}</p>
            {message.plan ? <PlanInline plan={message.plan} /> : null}
          </article>
        ))}
        <div ref={endRef} />
      </div>

      {canApprove && run ? (
        <ApprovalBar plan={run.plan} onApprove={onApprove} onCancel={onCancel} busy={busy} />
      ) : null}

      <form
        className="chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Describe a change…  (Enter to send, Shift+Enter for a new line)"
          rows={3}
          disabled={busy}
        />
        <button type="submit" className="btn btn--primary" disabled={busy || draft.trim() === ''}>
          {busy ? 'Working…' : 'Send'}
        </button>
      </form>
    </aside>
  );
}

function PlanInline({ plan }: { plan: Plan }): React.JSX.Element {
  return (
    <details className="plan-inline">
      <summary>
        {plan.steps.length} step{plan.steps.length === 1 ? '' : 's'} · {plan.route}
      </summary>
      <ol className="plan-inline__steps">
        {plan.steps.map((step) => (
          <li key={step.id} className={step.destructive ? 'step step--destructive' : 'step'}>
            <code>{step.tool.replace('photoshop.', '')}</code>
            {step.intent ? <span className="step__intent">{step.intent}</span> : null}
            {step.destructive ? <span className="chip chip--warn">needs approval</span> : null}
          </li>
        ))}
      </ol>
    </details>
  );
}

function ApprovalBar({
  plan,
  onApprove,
  onCancel,
  busy,
}: {
  plan: Plan | null;
  onApprove: (decisions: { stepId: string; approved: boolean }[]) => void;
  onCancel: () => void;
  busy: boolean;
}): React.JSX.Element {
  const confirmations: ConfirmationRequest[] = plan?.confirmations ?? [];
  const [declined, setDeclined] = useState<Record<string, boolean>>({});

  if (!plan) return <div className="approval" />;

  const allDeclined = confirmations.length > 0 && confirmations.every((c) => declined[c.stepId] === true);

  return (
    <div className="approval">
      <div className="approval__head">
        <strong>AI PLAN</strong>
        <span className="approval__goal">{plan.goal}</span>
      </div>

      {confirmations.length > 0 ? (
        <div className="approval__warning">
          <p>⚠ Confirmation required</p>
          <ul>
            {confirmations.map((confirmation) => (
              <li key={confirmation.stepId}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={declined[confirmation.stepId] !== true}
                    onChange={(event) =>
                      setDeclined((prev) => ({ ...prev, [confirmation.stepId]: !event.target.checked }))
                    }
                  />
                  <span>{confirmation.question}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="approval__actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || allDeclined}
          onClick={() => onApprove(confirmations.map((c) => ({ stepId: c.stepId, approved: declined[c.stepId] !== true })))}
        >
          {busy ? 'Applying…' : allDeclined ? 'Nothing to apply' : 'Apply'}
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
