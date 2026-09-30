import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HISTORY_LIMIT, type HistoryRecord } from '@photoshop-ai-studio/shared';

/**
 * Run history (§21).
 *
 * JSONL on disk (survives restarts, greppable, trivially diffable) plus an
 * in-memory tail for the Studio's HISTORY tab. Only fully-finished runs are
 * persisted — a run that was cancelled mid-flight is still recorded, but with
 * its real status, so the history never lies about what happened.
 */
export class HistoryStore {
  private readonly records: HistoryRecord[] = [];
  private readonly path: string;

  constructor(
    private readonly dataDir: string,
    private readonly limit = HISTORY_LIMIT,
  ) {
    this.path = join(dataDir, 'history.jsonl');
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
      const parsed: HistoryRecord[] = [];
      for (const line of lines.slice(-this.limit * 2)) {
        try {
          const record = JSON.parse(line) as HistoryRecord;
          if (record && typeof record.id === 'string') parsed.push(record);
        } catch {
          /* skip a corrupt line rather than losing the whole file */
        }
      }
      this.records.push(...parsed.slice(-this.limit));
    } catch {
      /* a broken history file must not stop the server from booting */
    }
  }

  add(record: HistoryRecord): void {
    this.records.push(record);
    while (this.records.length > this.limit) this.records.shift();
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
    } catch {
      /* persistence is best-effort */
    }
  }

  get(id: string): HistoryRecord | undefined {
    return this.records.find((r) => r.id === id || r.runId === id);
  }

  /** Newest first. */
  list(limit = 50): HistoryRecord[] {
    return this.records.slice(-limit).reverse();
  }

  get size(): number {
    return this.records.length;
  }
}
