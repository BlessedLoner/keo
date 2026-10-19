import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffSummary, hashText, inside, listFiles, readText, redactSecrets, runScript, writeText } from '../src/main/projects/workspace';
import type { ChatResult } from '../src/main/providers/types';
import { makeHarness, tempDir, waitFor, type Harness } from './helpers';

function workspace() {
  const root = tempDir();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'index.html'), '<h1>Hello</h1>\n<p>old</p>\n');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'vitest run', build: 'vite build', 'bad name;rm': 'x' } }));
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'x.js'), '');
  return root;
}

describe('workspace boundaries', () => {
  it('refuses paths that leave the folder', () => {
    const root = workspace();
    for (const p of ['../outside.txt', 'src/../../x', 'C:\\Windows\\win.ini', '/etc/passwd', 'src\\..\\..\\x']) expect(() => inside(root, p)).toThrow(/project folder|relative/);
    expect(inside(root, 'src/index.html')).toBe(path.join(fs.realpathSync(root), 'src', 'index.html'));
  });

  it('refuses a junction that leads outside', () => {
    const root = workspace();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, 'secret.txt'), 's');
    fs.symlinkSync(outside, path.join(root, 'link'), 'junction');
    expect(() => inside(root, 'link/secret.txt')).toThrow(/outside the project folder/);
    expect(listFiles(root).some((f) => f.path.startsWith('link'))).toBe(false);
  });

  it('lists files without node_modules', () => {
    const root = workspace();
    const files = listFiles(root).map((f) => f.path);
    expect(files).toContain('src/index.html');
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
  });
});

describe('safe edits', () => {
  it('writes atomically with a backup, and never overwrites a file that changed since it was read', () => {
    const root = workspace();
    const r = readText(root, 'src/index.html');
    expect(() => writeText(root, 'src/index.html', 'x', null)).toThrow(/Read the file first/);
    const w = writeText(root, 'src/index.html', '<h1>Hello</h1>\n<p>new</p>\n', r.hash);
    expect(w.created).toBe(false);
    expect(fs.readFileSync(path.join(root, w.backup!), 'utf8')).toContain('old');
    expect(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')).toContain('new');
    expect(() => writeText(root, 'src/index.html', 'again', r.hash)).toThrow(/changed since Keo read it/);
    expect(fs.readdirSync(path.join(root, 'src')).some((f) => f.endsWith('.tmp'))).toBe(false);
    expect(writeText(root, 'src/new.css', 'body{}', null).created).toBe(true);
  });

  it('shows a readable diff', () => {
    expect(diffSummary('a\nb\nc', 'a\nB\nc')).toEqual(['@@ line 2', '  a', '- b', '+ B', '  c']);
    expect(hashText('x')).toHaveLength(16);
  });
});

describe('controlled scripts', () => {
  function fakeSpawn(exit: number, output: string) {
    const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
    const spawnImpl = ((cmd: string, args: string[], opts: { cwd?: string }) => {
      calls.push({ cmd, args, cwd: opts?.cwd });
      const p = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; pid: number };
      p.stdout = new EventEmitter();
      p.stderr = new EventEmitter();
      p.pid = 1234;
      setTimeout(() => {
        p.stdout.emit('data', Buffer.from(output));
        p.emit('close', exit);
      }, 5);
      return p;
    }) as unknown as typeof import('node:child_process').spawn;
    return { calls, spawnImpl };
  }

  it('runs only package.json scripts, in the project folder, and redacts key-like strings', async () => {
    const root = workspace();
    const { calls, spawnImpl } = fakeSpawn(1, 'FAIL token sk-abcdefghijklmnopqrstuvwxyz123456\n');
    const r = await runScript(root, 'test', 5000, new AbortController().signal, spawnImpl);
    expect(r.exitCode).toBe(1);
    expect(r.output).toContain('[redacted]');
    expect(r.output).not.toContain('sk-abcdef');
    expect(calls[0]!.args.at(-1)).toBe('npm run test');
    expect(calls[0]!.cwd).toBe(fs.realpathSync(root));
    expect(() => runScript(root, 'deploy', 5000, new AbortController().signal, spawnImpl)).toThrow(/no "deploy" script/);
    expect(() => runScript(root, 'bad name;rm', 5000, new AbortController().signal, spawnImpl)).toThrow(/no "bad name;rm" script/);
    expect(redactSecrets('ghp_abcdefghijklmnopqrstuvwx')).toBe('[redacted]');
  });
});

let h: Harness;
afterEach(async () => {
  await h?.close();
});
const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: null, model: 'keo-test-1', native: undefined });

describe('file capabilities', () => {
  it('reads freely, but writing needs approval (with a diff) and secret files and scripts are guarded', async () => {
    const root = workspace();
    fs.writeFileSync(path.join(root, '.env'), 'KEY=1');
    h = makeHarness({ script: () => reply('ok') });
    const p = h.services.projects.create('Site');
    h.services.settings.update({ projectWorkspaces: { [p.id]: root }, agent: { approvalWaitSeconds: 10 } });
    const admitRead = h.services.registry.admit({ capabilityId: 'files.read', input: { projectId: p.id, path: 'src/index.html' }, origin: 'model', correlationId: 'c' });
    expect(admitRead.ok && !admitRead.requiresApproval).toBe(true);
    const w = h.services.registry.admit({ capabilityId: 'files.write', input: { projectId: p.id, path: 'src/index.html', content: '<h1>Hi</h1>\n', expectedHash: readText(root, 'src/index.html').hash }, origin: 'model', correlationId: 'c' });
    expect(w.ok && w.requiresApproval).toBe(true);
    if (w.ok) expect(w.preview.consequences.join('\n')).toMatch(/- <h1>Hello<\/h1>[\s\S]*\+ <h1>Hi<\/h1>/);
    const env = h.services.registry.admit({ capabilityId: 'files.write', input: { projectId: p.id, path: '.env', content: 'x' }, origin: 'model', correlationId: 'c' });
    expect(env.ok).toBe(false);
    const run = h.services.registry.admit({ capabilityId: 'files.run_script', input: { projectId: p.id, script: 'test' }, origin: 'model', correlationId: 'c' });
    expect(run.ok && run.requiresApproval && run.preview.autoTier === 'critical').toBe(true);
    const nope = h.services.registry.admit({ capabilityId: 'files.run_script', input: { projectId: p.id, script: 'deploy' }, origin: 'model', correlationId: 'c' });
    expect(nope.ok).toBe(false);
    // Approve the write through the normal task path and check the file.
    if (!w.ok) return;
    const t = h.services.tasks.create({ title: 'w', rationale: '', origin: 'model', conversationId: null, correlationId: 'c', steps: [{ admission: w, title: 'w', dependsOnIndexes: [] }] });
    h.services.tasks.submit(t.id);
    const step = h.services.tasks.get(t.id)!.steps[0]!;
    h.services.tasks.approveStep(step.id, step.inputHash);
    await waitFor(() => h.services.tasks.get(t.id)!.steps[0]!.state === 'succeeded', 5000);
    expect(h.services.tasks.get(t.id)!.steps[0]!.verification).toBe('verified');
    expect(fs.readFileSync(path.join(root, 'src', 'index.html'), 'utf8')).toBe('<h1>Hi</h1>\n');
  });
});

describe('workflows and export/import', () => {
  it('saves a completed task as a workflow without windows/elements, and exports/imports without secrets', async () => {
    h = makeHarness({ script: () => reply('ok') });
    const { WorkflowStore } = await import('../src/main/workflows/workflows');
    const { importBundle } = await import('../src/main/workflows/portability');
    const store = new WorkflowStore(path.join(tempDir(), 'wf.json'));
    const task = {
      id: 't1', title: 'Post the weekly update', state: 'completed', createdAt: '', updatedAt: '',
      steps: [
        { id: 's1', capabilityId: 'desktop.focus_window', title: 'Focus Slack', input: { target: { hwnd: '1', pid: 2, processName: 'slack' } }, dependsOn: [] },
        { id: 's2', capabilityId: 'desktop.type_text', title: 'Type the update', input: { target: { hwnd: '1', pid: 2, processName: 'slack' }, text: 'Weekly update', method: 'auto' }, dependsOn: ['s1'] },
      ],
    } as unknown as import('../src/shared/domain').Task;
    const wf = store.fromTask(task, 'Weekly update');
    expect(JSON.stringify(wf.steps)).not.toMatch(/hwnd|pid/);
    expect(wf.steps[1]).toMatchObject({ capability: 'desktop.type_text', input: { text: 'Weekly update', method: 'auto' }, dependsOn: [1] });
    expect(() => store.fromTask({ ...task, state: 'failed' } as typeof task, 'x')).toThrow(/completed/);

    const p = h.services.projects.create('Website');
    h.services.projects.addItem({ projectId: p.id, type: 'objective', content: 'Launch in May', status: 'open', provenance: 'user_authored' });
    h.services.secrets.set('openai', 'sk-should-never-be-exported-123456789');
    const bundle = { format: 'keo-export', version: 1, projects: [{ name: 'Website', description: '', status: 'active', items: [{ type: 'objective', content: 'Launch in May' }] }], workflows: [{ name: 'Weekly update', description: '', steps: wf.steps }, { name: 'Evil', description: '', steps: [{ capability: 'system.shell_exec', title: 'x', input: {}, dependsOn: [] }] }] };
    const r = importBundle(h.services, JSON.stringify(bundle));
    expect(r).toEqual({ projects: 1, workflows: 1, skipped: 1 });
    expect(h.services.projects.list().map((x) => x.name).sort()).toEqual(['Website', 'Website (imported)']);
    expect(h.services.workflows.list()[0]).toMatchObject({ name: 'Weekly update', imported: true });
    expect(() => importBundle(h.services, '{"format":"other"}')).toThrow(/not a valid Keo export/);
  });
});

describe('export file', () => {
  it('holds projects and workflows only — no keys, settings or conversations', async () => {
    h = makeHarness({ script: () => reply('ok') });
    h.services.secrets.set('openai', 'sk-should-never-be-exported-123456789');
    h.services.projects.create('Website');
    h.services.conversations.create('private chat');
    const out = path.join(tempDir(), 'export.json');
    const { createHandlers } = await import('../src/main/ipc/handlers');
    const handlers = createHandlers(h.services, { appInfo: () => ({ name: 'Keo', version: '0', electron: '', chrome: '', node: '', platform: '', packaged: false, testProviderEnabled: true }), openPath: async () => true, pickExecutable: async () => null, relaunch: () => undefined, pickSaveFile: async () => out });
    const r = await handlers['data:export']({} as never);
    expect(r).toMatchObject({ path: out, projects: 1, workflows: 0 });
    const text = fs.readFileSync(out, 'utf8');
    expect(text).toMatch(/"format": "keo-export"/);
    expect(text).not.toMatch(/sk-should|private chat|activeProvider|permissions/);
  });
});
