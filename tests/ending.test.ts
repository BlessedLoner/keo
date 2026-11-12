import { describe, expect, it } from 'vitest';
import { endingWords, turnEnding } from '../src/main/agent/ending';
import type { MessageMeta, ToolActivity } from '../src/shared/domain';

const tool = (outcome: ToolActivity['outcome'], summary = 'Send the email', extra: Partial<ToolActivity> = {}): ToolActivity => ({ callId: `c${Math.random()}`, capabilityId: 'email.send', summary, outcome, detail: '', ...extra });
const meta = (m: Partial<MessageMeta>): MessageMeta => m as MessageMeta;

describe('every piece of work ends honestly', () => {
  it('a plain answer has no ending; work that ran and checked out is done and checked', () => {
    expect(turnEnding('complete', meta({}), [])).toBeUndefined();
    expect(turnEnding('complete', meta({ tools: [tool('executed')] }), [])).toEqual({ kind: 'done_checked' });
  });

  it('is never better than what happened: unconfirmed, partly done, waiting, failed', () => {
    const sent = tool('executed', 'Send the email', { taskId: 't1' });
    expect(turnEnding('complete', meta({ tools: [sent] }), [{ activity: sent, why: 'unverified' }])).toMatchObject({ kind: 'done_unchecked', why: expect.stringContaining('Send the email (not confirmed)') });
    const failed = tool('failed', 'Post the reply', { taskId: 't2' });
    expect(turnEnding('complete', meta({ tools: [tool('executed', 'Read the page'), failed] }), [{ activity: failed, why: 'failed' }])).toMatchObject({ kind: 'partly_done', why: 'Not done: Post the reply.' });
    expect(turnEnding('complete', meta({ tools: [failed] }), [{ activity: failed, why: 'failed' }])).toMatchObject({ kind: 'failed' });
    expect(turnEnding('complete', meta({ tools: [tool('executed', 'Draft'), tool('awaiting_authorization', 'Send the invoice')] }), [])).toMatchObject({ kind: 'blocked', why: 'Waiting for your approval: Send the invoice.' });
    expect(turnEnding('complete', meta({ tools: [tool('failed', 'Open the app', { choices: ['Chrome', 'Edge'] })] }), [])).toMatchObject({ kind: 'blocked' });
    expect(turnEnding('complete', meta({ tools: [tool('executed'), tool('denied', 'Delete the old files')] }), [])).toMatchObject({ kind: 'partly_done', why: 'Not done: Delete the old files (you declined).' });
  });

  it('counts the plan: open or failed steps are not done, a done step without proof is not checked', () => {
    const plan = { steps: [{ title: 'Build the game', status: 'done' as const, note: 'Check drove 120 m' }, { title: 'Add sound', status: 'pending' as const }] };
    expect(turnEnding('complete', meta({ tools: [tool('executed')], plan }), [])).toMatchObject({ kind: 'partly_done', why: 'Not done: Add sound.' });
    const unproven = { steps: [{ title: 'Build the game', status: 'done' as const, doneWhen: 'the car moves' }] };
    expect(turnEnding('complete', meta({ tools: [tool('executed')], plan: unproven }), [])).toMatchObject({ kind: 'done_unchecked', why: 'Check: Build the game.' });
    expect(turnEnding('complete', meta({ tools: [tool('executed')], unsupportedClaims: ['typed the message'] }), [])).toMatchObject({ kind: 'done_unchecked' });
  });

  it('stopping, errors and limits', () => {
    expect(turnEnding('error', meta({ error: 'The model is busy.' }), [])).toEqual({ kind: 'failed', why: 'The model is busy.' });
    expect(turnEnding('cancelled', meta({ tools: [tool('executed')] }), [])).toMatchObject({ kind: 'partly_done' });
    expect(turnEnding('cancelled', meta({ tools: [tool('failed')] }), [])).toMatchObject({ kind: 'failed' });
    expect(turnEnding('complete', meta({ tools: [tool('executed')] }), [], 'the rest (Keo reached its step limit; say “continue”)')).toMatchObject({ kind: 'partly_done' });
    expect(endingWords({ kind: 'done_unchecked', why: 'Check: the email.' })).toBe('Done, but not checked. Check: the email.');
  });
});

describe('the Activity view and capability flags', () => {
  it('tells what happened in plain words, counting repeats', async () => {
    const { describeActivity } = await import('../src/main/agent/activity');
    const at = (n: number) => new Date(Date.UTC(2026, 10, 12, 10, n)).toISOString();
    const rec = (n: number, kind: string, decision: string, capabilityId: string | null = null, detail: Record<string, unknown> = {}) => ({ id: `a${n}`, ts: at(n), kind, decision, capabilityId, taskId: null, detail, correlationId: null });
    const out = describeActivity(
      [
        rec(9, 'capability.execution', 'succeeded', 'email.send'),
        rec(8, 'permission.decision', 'approved', 'email.send'),
        rec(7, 'capability.admission', 'admitted', 'email.send'),
        rec(6, 'capability.execution', 'failed', 'files.read', { error: 'Not found' }),
        rec(5, 'capability.execution', 'succeeded', 'web.search'),
        rec(4, 'capability.execution', 'succeeded', 'web.search'),
        rec(3, 'studio.ai_shot', 'sent', null, { costUsd: 0.5 }),
        rec(2, 'jobs.finished', 'completed', null, { ending: 'partly_done' }),
      ],
      (id) => ({ 'email.send': 'Send an email', 'files.read': 'Read a file', 'web.search': 'Search the web' })[id] ?? id,
    );
    expect(out.map((a) => [a.text, a.tone, a.times])).toEqual([
      ['Did: Send an email', 'done', 1],
      ['You approved: Send an email', 'you', 1],
      ['Could not: Read a file — Not found', 'failed', 1],
      ['Did: Search the web', 'done', 2],
      ['Made an AI video clip (about 100 Studio credits)', 'cost', 1],
      ['Background job completed (partly done)', 'done', 1],
    ]);
  });

  it('every tool that reads outside content is marked so its text is treated as data only', async () => {
    const { makeHarness } = await import('./helpers');
    const h = makeHarness();
    try {
      for (const id of ['email.read_thread', 'web.fetch_page', 'web.read', 'whatsapp.read_chat', 'files.read', 'screen.look', 'desktop.inspect_window']) expect(h.services.registry.get(id)?.outputTrust, id).toBe('external');
      for (const id of ['web.search', 'memory.search', 'system.datetime']) expect(h.services.registry.get(id)?.category, id).toBe('context');
      expect(h.services.registry.get('email.send')?.outputTrust).toBeUndefined();
    } finally {
      h.close();
    }
  });
});
