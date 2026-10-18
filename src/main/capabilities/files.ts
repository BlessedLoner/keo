import fs from 'node:fs';
import { z } from 'zod';
import type { Settings } from '../../shared/settings';
import { diffSummary, hashText, inside, isSecretFile, listFiles, packageScripts, readText, runScript, writeText } from '../projects/workspace';
import type { CapabilityDeps } from './builtins';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

const ProjectId = z.string().trim().min(1).max(80).describe('Project id from project__list');
const RelPath = z.string().trim().min(1).max(300).describe('Path relative to the project folder, e.g. "src/index.html"');

function rootOf(s: Settings, projectId: string): string {
  const root = s.projectWorkspaces[projectId];
  if (!root) throw new CapabilityError('no_workspace', 'This project has no folder yet. The user can choose one in Projects → Workspace folder.', { dispatched: 'no' });
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new CapabilityError('workspace_missing', 'The project folder no longer exists. The user can choose it again in Projects.', { dispatched: 'no' });
  return root;
}

/**
 * Files in a project's workspace folder (chosen by the user with the folder
 * picker): list and read freely, write only with approval (diff preview,
 * backup, atomic, refused if the file changed meanwhile), run only the
 * project's own package.json scripts with approval and a time limit.
 */
export function fileCapabilities(d: CapabilityDeps): AnyCapability[] {
  const list = defineCapability({
    id: 'files.list',
    version: '1.0.0',
    title: 'List project files',
    description: 'List files and folders in a project’s workspace folder (skips node_modules, .git, build output). Optional dir to list a subfolder.',
    input: z.object({ projectId: ProjectId, dir: z.string().trim().max(300).optional() }).strict(),
    output: z.object({ files: z.array(z.object({ path: z.string(), type: z.enum(['file', 'dir']), size: z.number() })), scripts: z.array(z.string()) }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 15000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'List project files', target: null, consequences: [], dataExport: `File names are sent to ${d.activeProviderDestination()}.` }),
    auditView: (i) => ({ projectId: i.projectId }),
    async execute(i, ctx) {
      const root = rootOf(ctx.settings, i.projectId);
      return { files: listFiles(root, i.dir ?? ''), scripts: Object.keys(packageScripts(root)) };
    },
  });

  const read = defineCapability({
    id: 'files.read',
    version: '1.0.0',
    title: 'Read a project file',
    description: 'Read a text file in a project’s workspace folder. Returns its text and a hash; pass that hash to files__write when editing it. Files that usually hold secrets (.env, keys) are read only when the user asked for that file by name.',
    input: z.object({ projectId: ProjectId, path: RelPath }).strict(),
    output: z.object({ path: z.string(), text: z.string(), hash: z.string(), truncated: z.boolean() }),
    risk: 'low',
    approval: 'never',
    permissions: [],
    consequential: false,
    idempotent: true,
    timeoutMs: 15000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Read-only.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Read ${i.path}`, target: null, consequences: [], dataExport: `The file’s text is sent to ${d.activeProviderDestination()}.` }),
    auditView: (i) => ({ projectId: i.projectId, ext: i.path.split('.').pop() ?? '' }),
    async execute(i, ctx) {
      if (isSecretFile(i.path) && !(ctx.conversationId && d.findUserQuote(ctx.conversationId, i.path.split(/[\\/]/).pop()!))) {
        throw new CapabilityError('secret_file', 'That file usually contains secrets; Keo reads it only when the user asks for it by name.', { dispatched: 'no' });
      }
      const r = readText(rootOf(ctx.settings, i.projectId), i.path);
      return { path: i.path, ...r };
    },
  });

  const write = defineCapability({
    id: 'files.write',
    version: '1.0.0',
    title: 'Write a project file',
    description:
      'Create or replace one text file in a project’s workspace folder. To change an existing file, read it first and pass expectedHash; Keo refuses if it changed meanwhile, keeps a backup in .keo-backups and writes atomically. The user sees a diff and approves each write. Never replace a working project with a template unless the user asked for that.',
    input: z.object({ projectId: ProjectId, path: RelPath, content: z.string().max(1_000_000), expectedHash: z.string().regex(/^[0-9a-f]{16}$/).optional() }).strict(),
    output: z.object({ path: z.string(), created: z.boolean(), backup: z.string().nullable(), hash: z.string() }),
    risk: 'medium',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: true,
    timeoutMs: 20000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'The file is read back and its hash compared after writing.',
    autonomy: () => ({ tier: 'important' }),
    precheck: (i, s) => {
      if (!s.projectWorkspaces[i.projectId]) return 'This project has no folder yet. The user can choose one in Projects → Workspace folder.';
      if (isSecretFile(i.path)) return 'Keo does not write files that usually hold secrets (.env, keys).';
      try {
        inside(s.projectWorkspaces[i.projectId]!, i.path);
      } catch (e) {
        return (e as Error).message;
      }
      return null;
    },
    preview: (i, s) => {
      let before = '';
      let exists = false;
      try {
        const full = inside(s.projectWorkspaces[i.projectId]!, i.path);
        exists = fs.existsSync(full);
        if (exists) before = fs.readFileSync(full, 'utf8');
      } catch {
        /* reported by precheck */
      }
      return {
        summary: `${exists ? 'Edit' : 'Create'} ${i.path}`,
        target: s.projectWorkspaces[i.projectId] ?? null,
        consequences: [...(exists ? ['A backup of the current version is kept in .keo-backups.'] : ['New file.']), ...diffSummary(before, i.content, 30)],
        dataExport: null,
      };
    },
    auditView: (i) => ({ projectId: i.projectId, chars: i.content.length, edit: !!i.expectedHash }),
    async execute(i, ctx) {
      const r = writeText(rootOf(ctx.settings, i.projectId), i.path, i.content, i.expectedHash ?? null);
      return { path: i.path, ...r };
    },
    async verify(i, o, ctx) {
      const back = fs.readFileSync(inside(rootOf(ctx.settings, i.projectId), i.path), 'utf8');
      return hashText(back) === o.hash ? { verified: true, detail: `${i.path} ${o.created ? 'created' : 'updated'}${o.backup ? ` (backup: ${o.backup})` : ''}.` } : { verified: false, detail: 'The file content differs from what was written.' };
    },
  });

  const run = defineCapability({
    id: 'files.run_script',
    version: '1.0.0',
    title: 'Run a project script',
    description: 'Run one of the project’s own package.json scripts (e.g. "test", "build", "lint") in its folder, with a time limit, and get the exit code and the end of the output. No other commands can run. Report failures honestly.',
    input: z.object({ projectId: ProjectId, script: z.string().trim().regex(/^[\w:.-]{1,40}$/), timeoutSeconds: z.number().int().min(10).max(900).default(300) }).strict(),
    output: z.object({ script: z.string(), exitCode: z.number().nullable(), timedOut: z.boolean(), output: z.string(), ms: z.number() }),
    risk: 'high',
    approval: 'always',
    permissions: [],
    consequential: true,
    idempotent: false,
    timeoutMs: 960_000,
    maxAttempts: 1,
    modelVisible: true,
    verificationPolicy: 'Exit code 0 means the script succeeded.',
    // A project's scripts run code on this computer: always a click.
    autonomy: () => ({ tier: 'always_ask', reason: 'Project scripts run code on your computer.' }),
    precheck: (i, s) => {
      const root = s.projectWorkspaces[i.projectId];
      if (!root) return 'This project has no folder yet.';
      const scripts = packageScripts(root);
      return scripts[i.script] ? null : `package.json has no "${i.script}" script. Available: ${Object.keys(scripts).join(', ') || 'none'}.`;
    },
    preview: (i, s) => ({
      summary: `Run “npm run ${i.script}” in the project folder`,
      target: s.projectWorkspaces[i.projectId] ?? null,
      consequences: [`Command: ${packageScripts(s.projectWorkspaces[i.projectId] ?? '')[i.script] ?? '?'}`, `Stops after ${i.timeoutSeconds} s.`],
      dataExport: null,
    }),
    auditView: (i) => ({ projectId: i.projectId, script: i.script }),
    async execute(i, ctx) {
      const r = await runScript(rootOf(ctx.settings, i.projectId), i.script, i.timeoutSeconds * 1000, ctx.signal);
      return { script: i.script, ...r };
    },
    async verify(_i, o) {
      if (o.timedOut) return { verified: false, detail: `Stopped after the time limit (${Math.round(o.ms / 1000)} s).` };
      return o.exitCode === 0 ? { verified: true, detail: `Finished successfully in ${Math.round(o.ms / 1000)} s.` } : { verified: false, detail: `Failed with exit code ${o.exitCode}.` };
    },
  });

  return [list, read, write, run];
}
