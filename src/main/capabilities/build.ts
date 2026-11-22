import { z } from 'zod';
import { CheckAction } from '../build/checkActions';
import { BUILD_LIBRARIES, BUILD_LIBRARY_IDS, type BuildLibraryId } from '../build/libraries';
import { BuildError, BuildId, BuildKind, TodoItem, type BuildManifest, type BuildProjects } from '../build/projects';
import { ART_DIRECTIONS, directionBrief, directionById, pickDirections } from '../build/directions';
import type { BuildCheck } from '../build/host';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

/**
 * Keo's builder tools: real websites (with backend and database), web apps and games (2D, motion,
 * 3D) as projects of many files, built step by step, checked in a sandboxed preview, fixed, and
 * shown to the user, with a clear list of what only the user can do to put them online.
 */
export interface BuildDeps {
  projects: BuildProjects;
  /** The preview and its checks (Keo's sandboxed windows); null in tests without Electron. */
  host: { open(id: string, page?: string): Promise<void>; check(id: string, page?: string, o?: { waitMs?: number; width?: number; height?: number; actions?: CheckAction[]; settle?: boolean }): Promise<BuildCheck>; changed?(id: string): void } | null;
  /** Keo's vision model looks at a screenshot: what it shows and what looks wrong; null when no model sees pictures. */
  look?: (png: Buffer, brief: string, signal: AbortSignal, mode?: 'check' | 'critique') => Promise<string>;
  /** An AI picture for the site (Keo's picture maker): PNG bytes. */
  picture?: (prompt: string, size: '1024x1024' | '1536x1024' | '1024x1536', signal: AbortSignal) => Promise<Buffer>;
  /** A real place from OpenStreetMap, as the drive kit's city.json. */
  city?: (place: string, radius: number, signal: AbortSignal) => Promise<{ json: string; name: string; roads: number; buildings: number; attribution: string }>;
  /** A realistic AI 3D model (GLB bytes) from a description; null when it cannot be made here (and why). */
  model3d?: { make: (prompt: string, signal: AbortSignal) => Promise<Buffer>; unavailable: () => string | null; costLabel: string };
}

const CRITIQUES_PER_WINDOW = 2;
const CRITIQUE_WINDOW_MS = 20 * 60_000;

const fail = (code: string, message: string) => new CapabilityError(code, message, { dispatched: 'no' });
const run = <T>(f: () => T): T => {
  try {
    return f();
  } catch (e) {
    if (e instanceof BuildError) throw fail('build', e.message);
    throw e;
  }
};

const LIB_HELP = BUILD_LIBRARY_IDS.map((id) => `${id}: ${BUILD_LIBRARIES[id].label}. ${BUILD_LIBRARIES[id].usage}`).join('\n');

const HOW_TO_BUILD = [
  'How Keo builds (follow it):',
  '0. One build per request: when the user continues ("continue", "are you done?", "fix it", "add…"), keep working on that build (build__start in the same chat gives it back with its files; build__list finds others); never start a second build for the same thing.',
  '1. Plan first: the pages or screens, the features, the data the backend keeps. Build the whole thing, not a demo: every page, every button working, real content (no lorem ipsum), mobile and desktop layouts.',
  'ART DIRECTION (Keo is a creative studio, not a template machine): build__start gives the build an art direction — type, colour, layout, motion, signature moves — chosen to suit it and different from Keo\'s recent builds; it lists two other directions too. Commit to it fully and push it further: it is the floor, not the ceiling. If the user describes a look, follow theirs instead (build__update direction, or none). Make every site feel designed by a top studio for THIS brand: a bold idea in the first screen (huge type, a moving shader or 3D scene, an unexpected layout), real hierarchy and rhythm, details that reward a closer look (hover states, micro-interactions, transitions between pages). Use the "fx" library for the signature moves (grain, shader backgrounds, split-text reveals, cursor, magnetic buttons, marquees, tilt, page wipes) and GSAP for scroll stories.',
  'NEVER (it makes sites look generic and dated): emoji as pictures or illustrations; the cream page + serif headline + three rounded cards template; a centred hero with two buttons over a stock gradient; icons in coloured circles as the main visuals; the same fonts as the last build. Pictures: build__picture (art-directed photos, renders, illustrations in one consistent style), SVG art, CSS art or a three.js scene — real visuals, not placeholders.',
  '2. Files: index.html at the root (and other pages: about.html, shop.html…), css/, js/, assets/. Pages link files by root paths (/css/site.css, /js/app.js). Split the code into several focused files (css/base.css, css/sections.css, js/motion.js, js/form.js…), never one huge file.',
  '   SMALL CALLS (a reply has a length limit; a call that is too long is cut off and fails): one file per build__write call, under 8,000 characters. A longer file is written in parts: build__write its first part, then build__append the next parts, each under 8,000 characters, in order. Never put a whole site in one call.',
  '3. Libraries come with Keo (never from the internet): list them in build__start or build__update and Keo copies them into /lib. Every site: "fonts" (the art direction\'s fonts), "icons" (Lucide icons; never emoji as icons) and "fx" (Keo\'s effects kit); "gsap" for scroll and motion. No CDN links, no Google Fonts links, no remote images: make pictures with build__picture, SVG, CSS or canvas.',
  '4. Backend (websites and apps that keep data, have accounts, forms, orders…): api/index.js written like a Cloudflare Worker — export default { async fetch(request, env) { … } } routing on new URL(request.url).pathname under /api/…, answering with Response.json(...). The database is env.DB, like Cloudflare D1: await env.DB.prepare("SELECT … WHERE id = ?").bind(id).all() → { results }, .first(), .run() → { meta: { last_row_id } }, env.DB.batch([...]). Tables in api/schema.sql (CREATE TABLE IF NOT EXISTS …), made automatically. Hash passwords with crypto.subtle (PBKDF2), keep sessions in a table with a random token in an HttpOnly cookie. Pages call it with fetch("/api/…"). Settings go in build__update vars (env.NAME); secrets (payment keys) never in files: put them on the to-do list.',
  '5. Check your work: build__check loads a page like a visitor, reports errors, missing files and what it looks like. Fix everything it finds (build__edit for small changes), check again until clean. Check every page, and the API by using the pages.',
  '6. To-do list: things only the user can do (buy a domain, create a Paystack or Stripe account and add its secret key, an email service, a Cloudflare account, legal pages’ details, real photos or texts) go in build__update todo with how to do each. Never pretend those are done.',
  '6b. Taste check (websites, landing pages, portfolios, shops, motion sites): once it works, build__check the home page with critique: true — an art director scores it and lists what would make it extraordinary. Apply the changes, and critique again if any score was below 8 (at most two rounds). A site that works but looks ordinary is not finished.',
  '7. Finish: build__open shows it to the user in Keo’s preview. Tell them what you built, the pages and features, how to try it, and their to-do list. PUT-IT-ONLINE.md in the folder explains going online.',
  '',
  'Car and driving games (racing, police chases, taxi and delivery, open-world city driving): ALWAYS the "drive" library — a tested engine with realistic lighting, real cities, real car physics, traffic, police, races, passengers to pick up, travel between cities, a garage and a HUD. Never write a car game from scratch. Steps: build__start with libraries ["drive"]; build__read lib/drive/README.md once (the whole API on one page — never read the kit\'s other files); build__city for the real place (a US downtown fits street racing; the kit shows the credit line). For a game across several cities or countries, build__city once per city into its own file (path "assets/cities/<name>.json") and list them in cities: the player travels between them; a whole country as one map is not possible, so say so and offer its main cities. For realistic cars build__model each car (about one per class, it costs credits: ask how many the user wants if unclear; without credits the kit draws its own cars). Then index.html calling createDriveGame with the cars, races, cities and jobs, and your own js files for missions and story on the returned game object. Car specs are in real units (power in newtons, about 8000–16000; topSpeed in metres per second, about 60–100), never 0–1 ratings. Make the brand and car names up (real brands need a licence). Check with build__check, then build__open.',
  'Before saying a game or an app works, USE it with build__check actions: start it, hold the controls, and measure that it responds (a speed above zero, a score that changed, a new item in the list). Report to the user what you tried and what you could not try. For the drive kit: expose the game as window.game, then actions [{do:"click",text:"Drive"},{do:"keys",keys:["KeyW"],holdSeconds:4},{do:"measure",expression:"Math.round(window.game.player.mph)"}] must show a speed above zero.',
  'Games: a real game, not a toy — a title screen, clear controls shown on screen (keyboard and touch), several levels or rising difficulty, score and best score (localStorage), lives or health, pause, game over and restart, sound effects and music made with Web Audio, juice (particles, screen shake, easing, hit flashes). 2D: Phaser. 3D: three.js (lights and shadows, fog, post-processing bloom when it suits, a proper camera) with Rapier for physics. Motion sites: GSAP with ScrollTrigger (pinned sections, scrubbed timelines, text reveals), three.js scenes in the background where it fits; respect prefers-reduced-motion.',
  '',
  'Libraries:',
  LIB_HELP,
].join('\n');

const Manifest = z.object({ id: z.string(), title: z.string(), kind: z.string(), folder: z.string(), libraries: z.array(z.string()), backend: z.boolean(), todo: z.array(z.object({ what: z.string(), how: z.string(), who: z.string(), done: z.boolean() })) });
const summary = (d: BuildDeps, m: BuildManifest) => ({ id: m.id, title: m.title, kind: m.kind, folder: run(() => d.projects.dir(m.id)), libraries: m.libraries, backend: m.backend, todo: m.todo });
const Libraries = z.array(z.enum(BUILD_LIBRARY_IDS as [BuildLibraryId, ...BuildLibraryId[]])).max(BUILD_LIBRARY_IDS.length);

export function buildCapabilities(d: BuildDeps): AnyCapability[] {
  const base = { version: '1.0.0', risk: 'low' as const, permissions: [], maxAttempts: 1, modelVisible: true };

  const start = defineCapability({
    ...base,
    id: 'build.start',
    title: 'Start a website, app or game',
    description: `Start a new build: a real website (with its backend), web app or game as a project of many files in Documents\\Keo\\Builds, previewed in Keo. Use it whenever the user wants a website, landing page, online shop, dashboard, web app, 2D/3D game or motion site (not create__web_app, which is one small file). Then write the files with build__write.\n\n${HOW_TO_BUILD}`,
    input: z
      .object({
        title: z.string().trim().min(1).max(120),
        kind: BuildKind,
        brief: z.string().trim().max(2000).describe('What it is and for whom, in a few sentences (kept with the build).'),
        libraries: Libraries.default([]),
        direction: z.string().max(40).optional().describe(`An art direction id (${ART_DIRECTIONS.map((x) => x.id).join(', ')}), or "none" when the user described their own look. Leave it out and Keo picks the best fit that recent builds did not use.`),
      })
      .strict(),
    output: Manifest.extend({ next: z.string(), continued: z.boolean(), files: z.array(z.object({ path: z.string(), bytes: z.number() })).optional(), artDirection: z.string().optional(), otherDirections: z.array(z.string()).optional() }),
    approval: 'never',
    consequential: false,
    idempotent: false,
    timeoutMs: 120_000,
    verificationPolicy: 'The project folder and keo-build.json exist.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Start the ${i.kind} “${i.title}”`, target: null, consequences: ['A new folder in Documents\\Keo\\Builds.'], dataExport: null }),
    auditView: (i) => ({ kind: i.kind, libraries: i.libraries }),
    async execute(i, ctx) {
      // Asked again in the same chat (Retry, continue, the request sent again): the same build carries on.
      const existing = ctx.conversationId ? d.projects.forConversation(ctx.conversationId) : null;
      if (existing) {
        const libs = [...new Set([...existing.libraries, ...i.libraries])] as BuildLibraryId[];
        const m = libs.length !== existing.libraries.length ? run(() => d.projects.update(existing.id, { libraries: libs })) : existing;
        return {
          ...summary(d, m),
          continued: true,
          files: run(() => d.projects.files(m.id)),
          ...(m.direction && directionById(m.direction) ? { artDirection: directionBrief(directionById(m.direction)!) } : {}),
          next: 'This chat already has this build: carry on with it (do not start another). Its files are listed: read what is there with build__read, write what is missing, fix what is broken, then build__check and build__open. Keep its art direction.',
        };
      }
      // An art direction that suits it and that Keo's last builds did not use (a drive game keeps the kit's own look).
      const recent = d.projects.list().slice(0, 4).map((b) => b.direction).filter((x): x is string => !!x);
      const options = pickDirections(i.brief, i.kind, recent, 3);
      const usesKitLook = i.libraries.includes('drive');
      const chosen = usesKitLook || i.direction === 'none' ? undefined : (i.direction && directionById(i.direction)) || options[0];
      const libraries = chosen ? ([...new Set([...i.libraries, 'fonts', 'icons', 'fx'])] as BuildLibraryId[]) : i.libraries;
      const m = run(() => d.projects.create({ title: i.title, kind: i.kind, brief: i.brief, libraries, ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}), ...(chosen ? { direction: chosen.id } : {}) }));
      return {
        ...summary(d, m),
        continued: false,
        ...(chosen ? { artDirection: directionBrief(chosen), otherDirections: options.filter((o) => o.id !== chosen.id).map((o) => `${o.id}: ${o.name} — ${o.mood}`) } : {}),
        next: `${chosen ? `Design it in the art direction above (${chosen.name}) and tell the user in one line which direction you chose (they can ask for another). ` : ''}Write the files with build__write (one file per call, under 8,000 characters; long files in parts with build__append), then build__check each page and fix what it finds.`,
      };
    },
  });

  const write = defineCapability({
    ...base,
    id: 'build.write',
    title: 'Write files of a build',
    description: 'Write (create or replace) files of a build: pages, styles, scripts, SVG pictures, api/index.js, api/schema.sql. Keep each call small: one file, under 8,000 characters (a longer file: its first part here, then build__append the rest). For small changes to an existing file use build__edit.',
    input: z
      .object({
        build: BuildId,
        files: z.array(z.object({ path: z.string().min(3).max(300), content: z.string().max(800_000) }).strict()).min(1).max(40),
      })
      .strict(),
    output: z.object({ written: z.array(z.string()), bytes: z.number(), next: z.string() }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 60_000,
    verificationPolicy: 'Each file is written whole (or not at all).',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Write ${i.files.length} file${i.files.length === 1 ? '' : 's'} of the build`, target: null, consequences: i.files.map((f) => f.path).slice(0, 10), dataExport: null }),
    auditView: (i) => ({ files: i.files.length }),
    async execute(i) {
      const r = run(() => d.projects.write(i.build, i.files));
      return { ...r, next: 'When the pages are written, build__check them.' };
    },
  });

  const append = defineCapability({
    ...base,
    id: 'build.append',
    title: 'Add the next part of a file',
    description: 'Add the next part of a long file of a build (written in parts so each call stays small): the file was started with build__write; each part under 8,000 characters, in order.',
    input: z.object({ build: BuildId, path: z.string().min(3).max(300), content: z.string().min(1).max(60_000) }).strict(),
    output: z.object({ path: z.string(), bytes: z.number() }),
    approval: 'never',
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    verificationPolicy: 'The part is added at the end of the file.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Add to ${i.path}`, target: null, consequences: [`${Math.round(i.content.length / 100) / 10}k characters`], dataExport: null }),
    auditView: () => ({}),
    async execute(i) {
      return run(() => d.projects.append(i.build, i.path, i.content));
    },
  });

  const edit = defineCapability({
    ...base,
    id: 'build.edit',
    title: 'Change part of a file of a build',
    description: 'Change parts of one file of a build: each find is copied exactly from the file (build__read) and must appear once; it is replaced. All changes apply or none.',
    input: z
      .object({
        build: BuildId,
        path: z.string().min(3).max(300),
        edits: z.array(z.object({ find: z.string().min(1).max(20_000), replace: z.string().max(200_000) }).strict()).min(1).max(30),
      })
      .strict(),
    output: z.object({ path: z.string(), bytes: z.number() }),
    approval: 'never',
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    verificationPolicy: 'Every change landed exactly once, or nothing changed.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Change ${i.path}`, target: null, consequences: [`${i.edits.length} change${i.edits.length === 1 ? '' : 's'}`], dataExport: null }),
    auditView: (i) => ({ edits: i.edits.length }),
    async execute(i) {
      return run(() => d.projects.edit(i.build, i.path, i.edits));
    },
  });

  const read = defineCapability({
    ...base,
    id: 'build.read',
    title: 'Read a build',
    description: 'List a build’s files (no path) with its settings, to-do list and where the work stands (the last check, open problems, recent changes), or read one file (path). Continuing a build (“continue editing the shop site”): read this first, then the files you will change, and pick up from the open problems.',
    input: z.object({ build: BuildId, path: z.string().min(3).max(300).optional() }).strict(),
    output: z.object({ build: Manifest.optional(), artDirection: z.string().optional(), files: z.array(z.object({ path: z.string(), bytes: z.number() })).optional(), state: z.unknown().optional(), next: z.string().optional(), path: z.string().optional(), content: z.string().optional(), truncated: z.boolean().optional() }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 15_000,
    verificationPolicy: 'Read from the project folder.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: i.path ? `Read ${i.path}` : 'List the build’s files', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i) {
      if (!i.path) {
        const st = run(() => d.projects.checkState(i.build));
        const recent = run(() => d.projects.versions(i.build)).slice(0, 4).map((v) => ({ version: v.version, at: v.lastAt.slice(0, 16).replace('T', ' '), files: v.files.slice(0, 8) }));
        const next = !st.last
          ? 'It has not been checked yet: read its main files, then build__check it (use it, not only load it) before changing more.'
          : !st.last.ok
            ? `Its last check found problems (state.lastCheck.problems): read the files involved and fix those first, then build__check.`
            : st.changedSinceCheck
              ? 'Files changed after its last check: build__check it first to see where it stands.'
              : 'Its last check passed: read the files you will change, make the change, then build__check again.';
        const man = run(() => d.projects.manifest(i.build));
        const dir = man.direction ? directionById(man.direction) : undefined;
        return {
          build: summary(d, man),
          ...(dir ? { artDirection: directionBrief(dir) } : {}),
          files: run(() => d.projects.files(i.build)),
          state: { lastCheck: st.last ? { at: st.last.at.slice(0, 16).replace('T', ' '), passed: st.last.ok, problems: st.last.problems } : null, lastGood: st.good?.at.slice(0, 16).replace('T', ' ') ?? null, changedSinceCheck: st.changedSinceCheck, recentChanges: recent },
          next,
        };
      }
      const text = run(() => d.projects.read(i.build, i.path!));
      return { path: i.path, content: text.slice(0, 120_000), truncated: text.length > 120_000 };
    },
  });

  const update = defineCapability({
    ...base,
    id: 'build.update',
    title: 'Change a build’s settings',
    description: 'Change a build’s title, brief, libraries (copied in from Keo), backend settings (vars: env.NAME values, never secrets) or the user’s to-do list (the whole list: what only the user can do, with how).',
    input: z
      .object({
        build: BuildId,
        title: z.string().trim().min(1).max(120).optional(),
        brief: z.string().trim().max(2000).optional(),
        libraries: Libraries.optional(),
        vars: z.record(z.string().regex(/^[A-Z][A-Z0-9_]{1,40}$/), z.string().max(400)).optional(),
        todo: z.array(TodoItem).max(40).optional(),
        direction: z.string().max(40).optional().describe('Another art direction id (when the user wants a different look), or "none".'),
      })
      .strict(),
    output: Manifest.extend({ artDirection: z.string().optional() }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 120_000,
    verificationPolicy: 'keo-build.json is saved.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Change the build’s settings', target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ libraries: i.libraries ?? null, todo: i.todo?.length ?? null }),
    async execute(i) {
      const { build, direction, ...patch } = i;
      if (direction && direction !== 'none' && !directionById(direction)) throw fail('invalid_input', `There is no art direction “${direction}”. Choose one of: ${ART_DIRECTIONS.map((x) => x.id).join(', ')}.`);
      const m = run(() => d.projects.update(build, { ...patch, ...(direction ? { direction: direction === 'none' ? undefined : direction } : {}) }));
      const dir = m.direction ? directionById(m.direction) : undefined;
      return { ...summary(d, m), ...(dir ? { artDirection: directionBrief(dir) } : {}) };
    },
  });

  const picture = defineCapability({
    ...base,
    id: 'build.picture',
    title: 'Make a picture for a build',
    description: 'Make an AI picture (hero image, product photo, illustration, game background or sprite sheet) and save it in the build (assets/….png), to use in its pages. Counts toward the user’s picture allowance: make the ones the design needs.',
    input: z
      .object({
        build: BuildId,
        path: z.string().regex(/^assets\/[A-Za-z0-9_/-]{1,120}\.png$/).describe('Where it goes, like assets/hero.png'),
        prompt: z.string().trim().min(10).max(3000),
        shape: z.enum(['square', 'wide', 'tall']).default('wide'),
      })
      .strict(),
    output: z.object({ path: z.string(), use: z.string() }),
    approval: 'never',
    consequential: false,
    idempotent: false,
    timeoutMs: 180_000,
    verificationPolicy: 'The picture is saved in the build.',
    unavailableReason: () => (d.picture ? null : 'Making pictures needs the user’s Keo account or an OpenAI key.'),
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Make the picture ${i.path}`, target: null, consequences: ['Uses one AI picture from the plan.'], dataExport: 'The description goes to the picture maker.' }),
    auditView: (i) => ({ shape: i.shape }),
    async execute(i, ctx) {
      if (!d.picture) throw fail('unavailable', 'Making pictures needs the user’s Keo account or an OpenAI key.');
      const png = await d.picture(i.prompt, i.shape === 'square' ? '1024x1024' : i.shape === 'tall' ? '1024x1536' : '1536x1024', ctx.signal);
      const rel = run(() => d.projects.writeBinary(i.build, i.path, png));
      return { path: rel, use: `<img src="/${rel}" alt="…"> or url(/${rel}) in CSS` };
    },
  });

  // The art director's critique costs a picture read and leads to rounds of changes: at most two per
  // build in a short while, so polishing never eats a whole request.
  const critiques = new Map<string, number[]>();
  const mayCritique = (build: string, now = Date.now()) => {
    const recent = (critiques.get(build) ?? []).filter((t) => now - t < CRITIQUE_WINDOW_MS);
    if (recent.length >= CRITIQUES_PER_WINDOW) return false;
    critiques.set(build, [...recent, now]);
    return true;
  };

  const check = defineCapability({
    ...base,
    id: 'build.check',
    title: 'Check a page of a build',
    description:
      'Load a page of a build like a visitor would (in Keo’s sandbox, with its API), let it run, and report its errors, missing files, the text it shows, and what it looks like (Keo’s vision model looks at a screenshot). Then USE it with actions, in order: {do:"click", text:"Play"} (the words on a button or link; or selector, or x and y for a canvas), {do:"keys", keys:["KeyW"], holdSeconds:3} (keys as KeyboardEvent.code, held together), {do:"type", text:"…", selector:"#email"}, {do:"scroll", y:800}, {do:"wait", seconds:2}, {do:"measure", expression:"window.game.player.mph"} (a JavaScript expression read in the page: a score, a speed, a count of items, whether a message is shown). The report lists what each action did; text and the screenshot are from after the actions. A page that loads is not proof it works: play the game (start it, hold the controls, measure that things move and the score changes), submit the form, open the menu. For a problem the user saw after a while ("the car breaks after a minute"), play that long: hold the keys up to 60 s at a time and measure the values involved (speed, health, position) before and after. Fix what it finds and check again. Use mobile: true to check the phone layout.',
    input: z
      .object({ build: BuildId, page: z.string().max(300).default(''), mobile: z.boolean().default(false), waitSeconds: z.number().min(1).max(15).default(3), actions: z.array(CheckAction).max(14).default([]), critique: z.boolean().default(false) })
      .strict(),
    output: z.object({
      page: z.string(),
      title: z.string(),
      ok: z.boolean(),
      errors: z.array(z.string()),
      warnings: z.array(z.string()),
      missing: z.array(z.string()),
      text: z.string(),
      steps: z.array(z.string()),
      used: z.boolean(),
      looks: z.string().nullable(),
      next: z.string(),
    }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 120_000,
    verificationPolicy: 'The page was loaded and observed.',
    unavailableReason: () => (d.host ? null : 'The preview is not available here.'),
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Check ${i.page || 'the home page'}`, target: null, consequences: [], dataExport: null }),
    auditView: (i) => ({ mobile: i.mobile }),
    async execute(i, ctx) {
      if (!d.host) throw fail('unavailable', 'The preview is not available here.');
      const m = run(() => d.projects.manifest(i.build));
      const critique = i.critique && mayCritique(i.build);
      const r = await d.host.check(i.build, i.page, { waitMs: i.waitSeconds * 1000, actions: i.actions, ...(i.mobile ? { width: 390, height: 844 } : {}), ...(critique ? { settle: true } : {}) });
      const steps = r.steps ?? [];
      // An action that found nothing to act on, or a value that could not be read, is a finding too.
      const stuck = steps.filter((s) => /: not (found|clicked)|→ error:|no answer from the page|the link did not open/.test(s));
      let looks: string | null = null;
      const dir = m.direction ? directionById(m.direction) : undefined;
      if (r.screenshot && d.look) looks = await d.look(r.screenshot, `${m.kind} “${m.title}”: ${m.brief}${dir ? ` (art direction: ${dir.name} — ${dir.mood})` : ''}`, ctx.signal, critique ? 'critique' : 'check').catch(() => null);
      const ok = !r.errors.length && !r.missing.length && !stuck.length;
      const used = steps.length > 0;
      const interactive = m.kind === 'game' || m.kind === 'app';
      const before = run(() => d.projects.checkState(i.build));
      // Only the home page (or the page asked for) counts; a pass that never used a game or app proves little.
      run(() => d.projects.recordCheck(i.build, { ok, good: ok && (used || !interactive), problems: [...r.errors, ...r.missing.map((x) => `missing ${x}`), ...stuck] }));
      const back = !ok && before.good && before.changedSinceGood ? ` It last passed a check at ${before.good.at.slice(0, 16).replace('T', ' ')}: if your fixes keep making it worse, build__undo with toLastGood: true puts it back to that state, then fix from there.` : '';
      return {
        page: r.page,
        title: r.title,
        ok,
        errors: r.errors,
        warnings: r.warnings,
        missing: r.missing,
        text: r.text,
        steps,
        used,
        looks,
        next: !ok
          ? stuck.length && !r.errors.length && !r.missing.length
            ? `Some actions did not work (see steps): either the page does not respond as it should — fix it — or the action named the wrong thing: read the page text and try again.${back}`
            : `Fix the errors and missing files (build__edit / build__write), then check again.${back}`
          : !used && interactive
            ? `It loads without errors, but nothing was tried yet: check again with actions that use the ${m.kind} (start it, hold the controls or fill the form, and measure that it responds) before telling the user it works.`
            : i.critique && !critique
              ? 'Works. The art director already reviewed this build twice just now: finish the changes from those notes, check the pages still work, then build__open it and tell the user what you made.'
              : critique
              ? 'Works. The art director’s notes are in looks: make the changes that lift it (bolder idea, type, composition, motion, real visuals) in as few edits as you can, then critique once more only if a score was below 8.'
              : 'No errors. Compare the measured values and the look with what should have happened; fix anything wrong, check the other pages (and mobile), then build__open it for the user.',
      };
    },
  });

  const open = defineCapability({
    ...base,
    id: 'build.open',
    title: 'Show a build to the user',
    description: 'Open a build in Keo’s preview window for the user (it reloads by itself while Keo keeps changing files).',
    input: z.object({ build: BuildId, page: z.string().max(300).default('') }).strict(),
    output: z.object({ opened: z.boolean(), folder: z.string() }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 30_000,
    verificationPolicy: 'The preview window is open.',
    unavailableReason: () => (d.host ? null : 'The preview is not available here.'),
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Show the build in Keo’s preview', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i) {
      if (!d.host) throw fail('unavailable', 'The preview is not available here.');
      await d.host.open(i.build, i.page).catch((e: unknown) => {
        throw fail('build', e instanceof Error ? e.message : String(e));
      });
      return { opened: true, folder: run(() => d.projects.dir(i.build)) };
    },
  });

  const list = defineCapability({
    ...base,
    id: 'build.list',
    title: 'List Keo’s builds',
    description: 'The websites, apps and games Keo built (newest first), to continue or change one (“the shop site you made yesterday”).',
    input: z.object({}).strict(),
    output: z.object({ builds: z.array(Manifest) }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 10_000,
    verificationPolicy: 'Read from Documents\\Keo\\Builds.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'List the builds', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute() {
      return { builds: d.projects.list().slice(0, 30).map((m) => summary(d, m)) };
    },
  });

  const history = defineCapability({
    ...base,
    id: 'build.history',
    title: 'A build’s earlier versions',
    description: 'The earlier versions of a build (newest first): when each change was made and which files it touched. Use it when the user wants to undo something or go back to how it was.',
    input: z.object({ build: BuildId }).strict(),
    output: z.object({ versions: z.array(z.object({ version: z.number(), at: z.string(), lastAt: z.string(), files: z.array(z.string()), changes: z.number() })) }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 15_000,
    verificationPolicy: 'Read from the project’s history.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'Look at the build’s earlier versions', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute(i) {
      return { versions: run(() => d.projects.versions(i.build)).slice(0, 30) };
    },
  });

  const undo = defineCapability({
    ...base,
    id: 'build.undo',
    title: 'Undo changes to a build',
    description: 'Go back to how a build was: without version, undo the latest change (“undo that”, “put it back”); with a version from build__history, undo that version and everything after it; with toLastGood, go back to how it was at its last passing build__check (when fixes keep making it worse). Files go back to how they were and files added since are removed. Then build__check it.',
    input: z.object({ build: BuildId, version: z.number().int().min(1).optional(), toLastGood: z.boolean().default(false) }).strict(),
    output: z.object({ version: z.number(), restored: z.array(z.string()), removed: z.array(z.string()) }),
    approval: 'never',
    consequential: false,
    idempotent: false,
    timeoutMs: 30_000,
    verificationPolicy: 'Each file is put back from the copy kept before it was changed.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: i.toLastGood ? 'Go back to the last version that passed its check' : i.version ? `Go back to before version ${i.version}` : 'Undo the latest change to the build', target: null, consequences: ['Files go back to how they were; files added since are removed.'], dataExport: null }),
    auditView: (i) => ({ version: i.version ?? null, toLastGood: i.toLastGood }),
    async execute(i) {
      return run(() => d.projects.goBack(i.build, i.toLastGood ? 'good' : i.version));
    },
  });

  const city = defineCapability({
    ...base,
    id: 'build.city',
    title: 'Put a real city into a game',
    description:
      'Download a real place (its streets, lanes, buildings with their real heights, parks and water) from OpenStreetMap and save it in the build as assets/city.json for the drive kit (createDriveGame({ city: "/assets/city.json" })). For a game with several cities, call it once per city with its own path (assets/cities/tokyo.json) and list them in createDriveGame({ cities: [...] }). place: a district or city, e.g. "Downtown Los Angeles, California", "Midtown Manhattan, New York", "The Strip, Las Vegas". radius: metres around its centre (700 is a good driving area; up to 1500). Takes up to two minutes. The game must show "© OpenStreetMap contributors" (the kit does).',
    input: z
      .object({
        build: BuildId,
        place: z.string().trim().min(3).max(160),
        radius: z.number().int().min(250).max(1500).default(700),
        path: z.string().regex(/^assets\/[A-Za-z0-9_/-]{1,80}\.json$/).default('assets/city.json'),
      })
      .strict(),
    output: z.object({ path: z.string(), name: z.string(), roads: z.number(), buildings: z.number(), attribution: z.string(), use: z.string() }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 300_000,
    verificationPolicy: 'The city file is saved in the build.',
    unavailableReason: () => (d.city ? null : 'Real cities need Keo’s map download (not available here).'),
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Put ${i.place} into the game`, target: null, consequences: ['Downloads map data from OpenStreetMap (free).'], dataExport: 'The place name goes to OpenStreetMap’s search.' }),
    auditView: (i) => ({ radius: i.radius }),
    async execute(i, ctx) {
      if (!d.city) throw fail('unavailable', 'Real cities need Keo’s map download.');
      let c: Awaited<ReturnType<NonNullable<BuildDeps['city']>>>;
      try {
        c = await d.city(i.place, i.radius, ctx.signal);
      } catch (e) {
        throw fail('city_failed', e instanceof Error ? e.message : String(e));
      }
      const rel = run(() => d.projects.writeBinary(i.build, i.path, Buffer.from(c.json)));
      return { path: rel, name: c.name, roads: c.roads, buildings: c.buildings, attribution: c.attribution, use: `createDriveGame({ city: "/${rel}" }) — or buildCity(world, await (await fetch("/${rel}")).json(), { physics })` };
    },
  });

  const model = defineCapability({
    ...base,
    id: 'build.model',
    title: 'Make a realistic 3D model for a game',
    description:
      'Make a realistic 3D model (a textured .glb) from a description, for a game: a car, a vehicle, a prop. Keo makes a studio picture of it with AI, then turns the picture into a 3D model (takes a few minutes). Describe it like a car photographer would: body style, era, colour and finish, details (e.g. "a low two-door supercar, sharp LED headlights, matte black with carbon details, big rear wing"); never a real brand or logo. Use the file as a car\'s model in the drive kit (cars: [{ …, model: "/assets/cars/name.glb" }]) or with loadCarModel. It costs Studio credits and the user approves each one.',
    input: z
      .object({
        build: BuildId,
        path: z.string().regex(/^assets\/[A-Za-z0-9_/-]{1,100}\.glb$/).describe('Where it goes, like assets/cars/raptor.glb'),
        prompt: z.string().trim().min(10).max(1500),
      })
      .strict(),
    output: z.object({ path: z.string(), kb: z.number(), use: z.string() }),
    approval: 'always',
    consequential: true,
    idempotent: true,
    timeoutMs: 15 * 60_000,
    verificationPolicy: 'The model file is saved in the build.',
    unavailableReason: () => (d.model3d ? d.model3d.unavailable() : 'Making 3D models needs Keo Cloud or your own fal.ai key.'),
    autonomy: () => ({ tier: 'important', reason: 'it costs Studio credits' }),
    preview: (i) => ({
      summary: `Make the 3D model ${i.path}`,
      target: null,
      consequences: [`Costs ${d.model3d?.costLabel ?? 'Studio credits'} (a realistic picture, then the 3D model).`, `Description: “${i.prompt.slice(0, 300)}”`],
      dataExport: 'The description and the picture go to fal.ai (through Keo Cloud, or your own fal.ai key).',
    }),
    auditView: (i) => ({ path: i.path }),
    async execute(i, ctx) {
      if (!d.model3d) throw fail('unavailable', 'Making 3D models needs Keo Cloud or your own fal.ai key.');
      const why = d.model3d.unavailable();
      if (why) throw fail('unavailable', why);
      let glb: Buffer;
      try {
        glb = await d.model3d.make(i.prompt, ctx.signal);
      } catch (e) {
        throw fail('model_failed', e instanceof Error ? e.message : String(e));
      }
      const rel = run(() => d.projects.writeBinary(i.build, i.path, glb));
      return { path: rel, kb: Math.round(glb.length / 1024), use: `cars: [{ id, name, style, price, spec, model: "/${rel}" }] in createDriveGame, or await loadCarModel("/${rel}")` };
    },
  });

  return [start, write, append, edit, read, update, picture, check, open, list, history, undo, city, model];
}
