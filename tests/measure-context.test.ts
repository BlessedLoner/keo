import { afterEach, describe, it } from 'vitest';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, type Harness } from './helpers';

/** Temporary measurement (not a test of behaviour): what one simple message sends to the model. */
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });
let h: Harness;
afterEach(async () => {
  await h?.close();
});

describe.skipIf(!process.env.KEO_MEASURE)('measure', () => {
  it('sizes', async () => {
    h = makeHarness({ script: () => reply('ok') });
    // Everything a real user might have on.
    h.services.settings.update({ files: { searchEnabled: true, readContent: true }, permissions: { webSearchEnabled: true, webFetchEnabled: true } });
    for (const msg of ['hi', 'what is the capital of Ghana?', 'check my email', 'open notepad and type hello', 'make a presentation about Keo', 'send Ana a WhatsApp message']) {
      const c1 = h.services.conversations.create();
      await h.services.agent.send(c1.id, msg).done;
      const r = h.provider.lastRequest!;
      const t = JSON.stringify(r.tools ?? []).length;
      console.log(`"${msg}": system ${Math.round(r.system.length / 4)} + tools ${Math.round(t / 4)} (${(r.tools ?? []).length}) = ~${Math.round((r.system.length + t) / 4)} tokens`);
    }
    h.services.settings.update({ agent: { toolSelection: 'all' } });
    const c = h.services.conversations.create();
    await h.services.agent.send(c.id, 'hi').done;
    const req = h.provider.lastRequest!;
    console.log('--- with every tool (before):');
    const tools = req.tools ?? [];
    const sizes = tools.map((t) => ({ name: t.name, chars: JSON.stringify(t).length })).sort((a, b) => b.chars - a.chars);
    const toolChars = sizes.reduce((n, t) => n + t.chars, 0);
    const msgChars = JSON.stringify(req.messages).length;
    console.log(`system: ${req.system.length} chars (~${Math.round(req.system.length / 4)} tokens)`);
    console.log(`tools: ${tools.length} tools, ${toolChars} chars (~${Math.round(toolChars / 4)} tokens)`);
    console.log(`messages: ${msgChars} chars (~${Math.round(msgChars / 4)} tokens)`);
    console.log('largest tools:\n' + sizes.slice(0, 25).map((t) => `  ${t.name}: ${t.chars}`).join('\n'));
  });
});
