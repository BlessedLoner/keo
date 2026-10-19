import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { Services } from '../services';

/**
 * Development-only physical end-to-end check (KEO_E2E_DESKTOP=1, never in
 * packaged builds). Launches a disposable WhatsApp-like test app as a separate
 * process and drives it through Keo's REAL services: Win32/UI Automation
 * helper, capability registry, orchestrator and approvals. No real accounts,
 * messages or other applications are touched.
 */
export async function runDesktopE2E(s: Services, opts: { electronPath: string; fixtureDir: string; outFile: string; workDir: string }): Promise<void> {
  const results: Record<string, unknown> = {};
  const stateFile = path.join(opts.workDir, 'fake-wa-state.json');
  fs.rmSync(stateFile, { force: true });
  const inboxFile = path.join(opts.workDir, 'fake-wa-inbox.json');
  fs.writeFileSync(inboxFile, '[]');
  const inbox: Array<{ from: string; text: string }> = [];
  const receive = (from: string, text: string) => {
    inbox.push({ from, text });
    fs.writeFileSync(inboxFile, JSON.stringify(inbox));
  };
  // Use the most-scaled monitor: mixed scaling is where pointer coordinates go wrong.
  const { screen } = await import('electron');
  const displays = screen.getAllDisplays();
  const display = [...displays].sort((a, b) => b.scaleFactor - a.scaleFactor)[0] ?? screen.getPrimaryDisplay();
  results.display = { count: displays.length, scaleFactors: displays.map((x) => x.scaleFactor), used: display.scaleFactor };
  const env: Record<string, string | undefined> = {
    ...process.env,
    FAKE_WA_STATE: stateFile,
    FAKE_WA_INBOX: inboxFile,
    FAKE_WA_X: String(display.workArea.x + 20),
    FAKE_WA_Y: String(display.workArea.y + 20),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_RENDERER_URL;
  const fake = spawn(opts.electronPath, [path.join(opts.fixtureDir, 'main.cjs'), `--user-data-dir=${path.join(opts.workDir, 'fake-wa-profile')}`], { env, stdio: 'ignore' });
  const state = () => {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf8')) as { pid: number; open: string | null; sent: Array<{ to: string; text: string }>; tab: string };
    } catch {
      return null;
    }
  };
  const wait = async (pred: () => boolean, ms = 30000) => {
    const t = Date.now();
    while (!pred()) {
      if (Date.now() - t > ms) throw new Error('e2e wait timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  };
  try {
    await wait(() => !!state(), 90000).catch(() => {
      throw new Error('the test app did not start within 90 s');
    });
    s.settings.update({
      permissions: { observationEnabled: true, desktopControlEnabled: true, allowedApps: [{ processName: 'electron', label: 'Fake WhatsApp' }] },
    });
    let target: { hwnd: string; pid: number; processName: string } | null = null;
    for (let i = 0; i < 60 && !target; i++) {
      const ws = await s.desktop.listWindows(s.settings.get(), false);
      const w = ws.find((x) => x.title === 'Fake WhatsApp — Keo test');
      if (w) target = { hwnd: w.hwnd, pid: w.pid, processName: w.processName };
      else await new Promise((r) => setTimeout(r, 250));
    }
    if (!target) throw new Error('fake app window not found');
    results.target = { processName: target.processName };

    const run = async (capabilityId: string, input: Record<string, unknown>, decision: 'approve' | 'deny' | 'none' = 'approve') => {
      const a = s.registry.admit({ capabilityId, input: { target, ...input }, origin: 'model', correlationId: 'e2e' });
      if (!a.ok) return { rejected: a.reason };
      const t = s.tasks.create({ title: capabilityId, rationale: 'e2e', origin: 'model', conversationId: null, correlationId: 'e2e', steps: [{ admission: a, title: capabilityId, dependsOnIndexes: [] }] });
      s.tasks.submit(t.id);
      const step = s.tasks.get(t.id)!.steps[0]!;
      if (step.state === 'awaiting_authorization') {
        if (decision === 'none') return { state: 'awaiting_authorization', taskId: t.id };
        if (decision === 'deny') {
          s.tasks.denyStep(step.id);
          return { state: s.tasks.get(t.id)!.state };
        }
        s.tasks.approveStep(step.id, step.inputHash);
      } else s.tasks.pump();
      await wait(() => ['completed', 'failed', 'cancelled', 'outcome_uncertain'].includes(s.tasks.get(t.id)!.state), 90000);
      const done = s.tasks.get(t.id)!;
      const st = done.steps[0]!;
      return { state: done.state, verification: st.verification, detail: st.verificationDetail, error: st.error, result: st.result };
    };

    // The page must have loaded (the app reports its state) before the first observation, and the
    // disposable test app is brought to the front: Chromium apps hide their page while fully covered.
    await wait(() => !!state(), 20000).catch(() => undefined);
    await s.desktop.backend.focus(target.hwnd).catch(() => undefined);
    // …and it needs a moment to show its page again after coming to the front.
    for (let i = 0; i < 20; i++) {
      const probe = await s.desktop.backend.uiaSnapshot(target.hwnd, { maxNodes: 200, maxDepth: 30, budgetMs: 3000 });
      if (probe.nodes.some((n) => n.role === 'document' || n.role === 'tabitem')) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    {
      const raw = await s.desktop.backend.uiaSnapshot(target.hwnd, { maxNodes: 400, maxDepth: 40, budgetMs: 5000 });
      const roles: Record<string, number> = {};
      for (const n of raw.nodes) roles[n.role] = (roles[n.role] ?? 0) + 1;
      results.firstRaw = { covered: await s.desktop.backend.coveredShare(target.hwnd).catch(() => null), foreground: (await s.desktop.backend.userActivity().catch(() => null))?.foreground === target.hwnd, nodes: raw.nodes.length, contentRoots: raw.contentRoots ?? null, roles, classes: await s.desktop.backend.childClasses?.(target.hwnd).catch(() => null), engine: s.desktop.backend.uiaEngine?.(target.hwnd) };
    }
    // 1. Fresh observation and section navigation.
    const snap1 = (await run('desktop.inspect_window', {})) as { result: { snapshotId: string; elements: Array<{ id: string; role: string; name: string }> } };
    const settingsTab = snap1.result.elements.find((e) => e.name === 'Settings' && e.role === 'tabitem');
    results.inspect = { elements: snap1.result.elements.length, foundSettingsTab: !!settingsTab, roles: [...new Set(snap1.result.elements.map((e) => e.role))].slice(0, 12) };
    const nav = await run('desktop.invoke_element', { snapshotId: snap1.result.snapshotId, elementId: settingsTab?.id ?? 'e0', action: 'invoke' });
    await wait(() => state()?.tab === 'settings', 5000).catch(() => undefined);
    results.navigateToSettings = { state: (nav as { state: string }).state, appTab: state()?.tab };
    const snap2 = (await run('desktop.inspect_window', {})) as { result: { snapshotId: string; elements: Array<{ id: string; role: string; name: string }> } };
    results.settingsVisible = snap2.result.elements.some((e) => e.name.includes('Notifications'));
    const chatsTab = snap2.result.elements.find((e) => e.name === 'Chats' && e.role === 'tabitem');
    results.backToChats = await run('desktop.invoke_element', { snapshotId: snap2.result.snapshotId, elementId: chatsTab?.id ?? 'e0', action: 'invoke' });
    await wait(() => state()?.tab === 'chats', 5000).catch(() => undefined);
    results.appTabAfterChats = state()?.tab;
    {
      const raw = await s.desktop.backend.uiaSnapshot(target.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
      const { analyzeWhatsApp } = await import('../desktop/whatsapp');
      const v = analyzeWhatsApp(raw.nodes, raw.window);
      results.waView = {
        window: raw.window,
        search: v.search ? { name: v.search.name, x: v.search.x, w: v.search.w, off: v.search.offscreen } : null,
        chats: v.chats.map((c) => c.title),
        header: v.header,
        edits: raw.nodes.filter((n) => n.role === 'edit' || n.role === 'document').map((n) => ({ role: n.role, name: n.name, x: n.x, w: n.w, off: n.offscreen ?? false })),
      };
    }

    // 1b. A real pointer click lands exactly on the element (DPI / multi-monitor coordinates).
    {
      await s.desktop.backend.focus(target.hwnd);
      // Let Chromium finish restoring its previous focus after activation before clicking.
      await new Promise((r) => setTimeout(r, 1500));
      const raw = await s.desktop.backend.uiaSnapshot(target.hwnd, { maxNodes: 1500, maxDepth: 60, budgetMs: 9000 });
      const searchNode = raw.nodes.find((n) => n.role === 'edit' && /search/i.test(n.name));
      let error: string | null = null;
      try {
        const c = await s.desktop.backend.uiaCenter(target.hwnd, searchNode!.rid);
        await s.desktop.backend.clickScreen(target.hwnd, c.x, c.y);
      } catch (e) {
        error = (e as Error).message;
      }
      await new Promise((r) => setTimeout(r, 600));
      results.pointerClick = { found: !!searchNode, error, pressed: (state() as { pressed?: string } | null)?.pressed ?? null, active: (state() as { active?: string } | null)?.active ?? null, helper: (await s.desktop.backend.helperInfo?.().catch(() => null)) ?? null };
    }

    // 2. Re-using an unchanged element from an earlier (fresh) observation is allowed after re-validation.
    const chatsTab1 = snap1.result.elements.find((e) => e.name === 'Chats' && e.role === 'tabitem');
    results.reuseUnchanged = (await run('desktop.invoke_element', { snapshotId: snap1.result.snapshotId, elementId: chatsTab1?.id ?? 'e0', action: 'invoke' })) as unknown;
    // 2b. A control that has since disappeared (the Settings-panel checkbox, hidden now) is refused, nothing dispatched.
    const notif = snap2.result.elements.find((e) => e.name.includes('Notifications') && e.role === 'checkbox');
    const stale = (await run('desktop.invoke_element', { snapshotId: snap2.result.snapshotId, elementId: notif?.id ?? 'e0', action: 'toggle' })) as { state: string; error: unknown };
    results.staleRefused = { found: !!notif, state: stale.state, error: stale.error, appTab: state()?.tab };

    // 3. WhatsApp: ambiguity, exact open, read.
    results.openAmbiguous = ((await run('whatsapp.open_chat', { contact: 'Daniel' })) as { result: unknown }).result;
    results.openExact = await run('whatsapp.open_chat', { contact: 'Daniel Okafor' });
    results.appOpenChat = state()?.open;
    results.read = ((await run('whatsapp.read_chat', { contact: 'Daniel Okafor' })) as { result: unknown }).result;

    // 4. No send without approval, none after denial.
    const pending = (await run('whatsapp.send_message', { contact: 'Daniel Okafor', text: 'E2E: not approved' }, 'none')) as { taskId: string };
    s.tasks.cancel(pending.taskId);
    await run('whatsapp.send_message', { contact: 'Daniel Okafor', text: 'E2E: denied' }, 'deny');
    await new Promise((r) => setTimeout(r, 800));
    results.sentAfterCancelAndDeny = state()?.sent ?? null;

    // 5. Approved send, verified; duplicate protection on repeat.
    results.send = await run('whatsapp.send_message', { contact: 'Daniel Okafor', text: 'E2E approved message' });
    await new Promise((r) => setTimeout(r, 500));
    results.repeat = await run('whatsapp.send_message', { contact: 'Daniel Okafor', text: 'E2E approved message' });
    await new Promise((r) => setTimeout(r, 500));
    results.sentFinal = state()?.sent ?? null;

    // 6. Live chat: one approval, replies on its own, pauses on a price question, uses the
    //    user's answer, stops on request. The reply "brain" is Keo's offline test provider.
    {
      const { TestProvider } = await import('../providers/testProvider');
      const test = s.providers.get('test');
      if (test instanceof TestProvider) {
        s.settings.update({ activeProvider: 'test', liveChat: { idleSeconds: 0 } });
        test.setScript((req) => {
          const text = (() => {
            if (!req.system.includes('replying in a WhatsApp chat on behalf of')) return 'ok';
            const chat = JSON.stringify(req.messages);
            if (/50 per blender/.test(req.system)) return JSON.stringify({ action: 'reply', message: 'They are $50 each, and I can give you a discount', covered_by_guidance: true });
            if (/how much/i.test(chat)) return JSON.stringify({ action: 'reply', message: 'It is $40' }); // would invent a price
            return JSON.stringify({ action: 'reply', message: 'Doing great, thanks for asking!' });
          })();
          return { text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined };
        });
        const live = s.live;
        const before = state()?.sent.length ?? 0;
        const started = await run('whatsapp.live_chat_start', { contact: 'Daniel Smith', goal: 'Keep Daniel company' });
        const session = () => live.list().find((x) => x.contact === 'Daniel Smith');
        results.liveStart = { state: (started as { state: string }).state, status: session()?.status ?? null };
        receive('Daniel Smith', 'Hi! How are you doing today?');
        await wait(() => (state()?.sent.length ?? 0) > before, 60000).catch(() => undefined);
        results.liveReplied = state()?.sent.slice(before) ?? [];
        receive('Daniel Smith', 'How much is the blender?');
        await wait(() => session()?.status === 'waiting_user', 60000).catch(() => undefined);
        results.livePaused = { status: session()?.status ?? null, question: session()?.question ?? null, sentSince: (state()?.sent.length ?? 0) - before, activity: session()?.activity ?? null, transcript: session()?.transcript.slice(-5).map((l) => l.from + ':' + l.text), pageLastMsg: (state() as { lastMsg?: string } | null)?.lastMsg ?? null, covered: await s.desktop.backend.coveredShare(target.hwnd).catch(() => -1), keoSees: await (async () => { const { waView } = await import('../capabilities/advanced'); const v = await waView(s.capDeps, target); return { header: v.header, msgs: v.messages.slice(-3).map((m) => m.from + ':' + m.text) }; })() };
        const id = session()?.id;
        if (id) live.answer(id, 'tell him it is 50 per blender and I can give a discount', true);
        await wait(() => (state()?.sent.length ?? 0) > before + 1, 60000).catch(() => undefined);
        results.liveAnswered = state()?.sent.slice(before + 1) ?? [];
        if (id) live.stop(id);
        const afterStop = state()?.sent.length ?? 0;
        receive('Daniel Smith', 'Are you still there?');
        await new Promise((r) => setTimeout(r, 6000));
        results.liveStopped = { status: session()?.status ?? null, sentAfterStop: (state()?.sent.length ?? 0) - afterStop };
      } else results.liveSkipped = 'test provider not available';
    }
    results.ok = true;
  } catch (e) {
    results.error = (e as Error).message;
    results.ok = false;
  } finally {
    fs.writeFileSync(opts.outFile, JSON.stringify(results, null, 2));
    try {
      fake.kill();
    } catch {
      /* ignore */
    }
  }
}
