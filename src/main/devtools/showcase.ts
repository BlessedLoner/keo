import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import type { BuildHost } from '../build/host';
import type { Services } from '../services';
import { sfxWav } from '../studio/sfx';
import type { EditOp } from '../../shared/studio';

/**
 * Development only (KEO_SHOWCASE=<folder>): Keo's product tour, made by Keo. In a throw-away
 * profile with tidy demo content, Keo opens each part of the app and captures it in HD, then Keo
 * Studio assembles the tour (each screen in a floating window that slowly pushes in, slides
 * between them, titles, whooshes) and exports the MP4 with a voice-over script timed to it.
 */

interface Scene {
  shot: string;
  title: string;
  sub: string;
  /** Where the slow push-in goes (fractions of the screen). */
  focus: [number, number];
  seconds: number;
  /** What the narrator says over it. */
  voice: string;
}

const W = 1600;
const H = 900;

export async function runShowcase(win: BrowserWindow, s: Services, host: BuildHost | null, out: string): Promise<Record<string, unknown>> {
  fs.mkdirSync(out, { recursive: true });
  const shots = path.join(out, 'screens');
  fs.mkdirSync(shots, { recursive: true });
  const log: string[] = [];
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const js = (code: string) => win.webContents.executeJavaScript(`(async () => { const call = async (ch, input) => { const r = await window.keo.invoke(ch, input); if (!r.ok) throw new Error(r.error.message); return r.value; }; ${code} })()`);
  const click = (selector: string, text?: string) =>
    js(`const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((b) => ${text ? `b.textContent.includes(${JSON.stringify(text)})` : 'true'}); if (el) el.click(); return !!el;`);
  const fill = (selector: string, value: string) =>
    js(`const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const p = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(p, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  const snap = async (name: string) => {
    await wait(350);
    fs.writeFileSync(path.join(shots, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    log.push(name);
  };
  const nav = async (label: string) => {
    await click('nav.rail button', label);
    await wait(900);
  };

  // ---------------------------------------------------------------- the window and demo content
  win.setSize(W, H);
  win.showInactive();
  win.webContents.setBackgroundThrottling(false);
  await js(`await call('settings:update', { patch: { activeProvider: 'test', ui: { onboarded: true } } });`);
  // Test labels are not part of the product: hidden for the tour.
  await win.webContents.insertCSS('.titlebar .chip.violet, .titlebar .brand small { display: none !important; } ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }');

  const chat = s.conversations.create('Launch week plan');
  const say = (role: 'user' | 'assistant', content: string) => s.conversations.addMessage({ conversationId: chat.id, role, content, status: 'complete' });
  say('user', 'Plan my launch week for the new collection, and draft the Instagram captions.');
  say(
    'assistant',
    [
      'Here is your launch week, built around your calendar (you are free most afternoons):',
      '',
      '**Monday** — teaser reel and countdown sticker',
      '**Tuesday** — behind-the-scenes video (I can edit it in Studio)',
      '**Wednesday** — launch post at 6 pm, email to your list',
      '**Thursday** — customer reactions and a giveaway',
      '**Friday** — recap reel with the best moments',
      '',
      '**Captions**',
      '1. “Something new is coming. Friday, 6 pm. Set your reminder.”',
      '2. “Made by hand, made for you. The collection is live.”',
      '3. “You said it best. Thank you for an amazing launch week.”',
      '',
      'Shall I put these on your calendar and make the teaser reel?',
    ].join('\n'),
  );
  say('user', 'Yes, and remind me Thursday morning to pick the giveaway winner.');
  say('assistant', 'Done: five launch events are on your calendar, the teaser reel is in Studio, and I will remind you on Thursday at 9:00 to pick the winner.');
  s.conversations.create('Website for the shop');
  s.conversations.create('Reply to Ada about the shoot');
  s.memory.create({ kind: 'preference', subject: 'style.answers', content: 'Likes short answers with clear next steps.', status: 'confirmed', provenance: 'user_authored' });
  s.memory.create({ kind: 'fact', subject: 'business', content: 'Runs a fashion brand and posts daily on Instagram and TikTok.', status: 'confirmed', provenance: 'user_authored' });
  s.memory.create({ kind: 'preference', subject: 'video.style', content: 'Prefers bold captions and warm colours in videos.', status: 'confirmed', provenance: 'user_authored' });
  const proj = s.projects.create('Spring collection launch', 'Launch the new collection across Instagram, TikTok and email.');
  for (const [type, content] of [
    ['objective', 'Reach 10,000 views on the launch reel'],
    ['decision', 'Launch on Friday at 6 pm'],
    ['blocker', 'Waiting for the final product photos'],
    ['progress', 'Teaser reel edited in Studio'],
  ] as const)
    s.projects.addItem({ projectId: proj.id, type, content, status: 'open', provenance: 'user_authored' });

  // A character with the user's own pictures, and a Studio project with their footage.
  const characterPics = (process.env.KEO_SHOWCASE_CHARACTER ?? '').split(';').filter((f) => f && fs.existsSync(f));
  if (characterPics.length) {
    const kira = s.studio.saveCharacter({ name: 'Kira', look: 'young woman, long wavy blonde hair, elegant black outfit, warm smile', voice: 'nova', notes: 'Confident, playful, talks to the viewer like a friend' });
    for (const f of characterPics.slice(0, 3)) s.studio.addCharacterPicture(kira.id, f);
    s.studio.saveCharacter({ name: 'Leo', look: 'man in his thirties, short dark hair, denim jacket', voice: 'onyx', notes: 'Calm storyteller' });
  }
  const footage = process.env.KEO_SHOWCASE_FOOTAGE;
  if (footage && fs.existsSync(footage)) {
    const p = s.studio.create('Launch teaser', 'vertical');
    const added = (await s.studio.importFiles(p.id, [footage])).added[0];
    if (added && added.kind === 'video') {
      const d = Math.min(14, added.duration);
      s.studio.edit(p.id, [
        { op: 'add_media', assetId: added.id, start: 0, duration: d },
        { op: 'add_text', text: 'THE NEW COLLECTION', start: 0.4, duration: 3.2, animIn: 'words', style: { sizePct: 7, weight: 'black', uppercase: true, color: '#FFFFFF', glow: 14, glowColor: '#8B6BFF' }, transform: { y: 0.3 } },
        { op: 'add_text', text: 'Friday · 6 pm', start: 3.8, duration: 3, animIn: 'pop', style: { sizePct: 5, weight: 'bold', box: true, boxColor: '#8B6BFF', color: '#FFFFFF' }, transform: { y: 0.72 } },
      ]);
    }
  }

  // The page loads again with the demo content (made directly in Keo's data, after it opened).
  await new Promise<void>((resolve) => {
    win.webContents.once('did-finish-load', () => resolve());
    win.webContents.reload();
  });
  await wait(2500);
  await win.webContents.insertCSS('.titlebar .chip.violet, .titlebar .brand small, .warn-text { display: none !important; } .composer-foot { visibility: hidden !important; } ::-webkit-scrollbar { width: 0 !important; height: 0 !important; }');

  // ---------------------------------------------------------------- the captures
  await nav('Chat');
  await click('.conv-item', 'Launch week plan');
  await wait(900);
  await snap('chat');
  await nav('Call');
  await snap('call');
  await nav('Memory');
  await snap('memory');
  await nav('Projects');
  await snap('projects');
  await nav('Studio');
  await wait(1500);
  await snap('studio-editor');
  await click('.studio-bar button', 'New');
  await wait(700);
  await snap('studio-home');
  await click('button', 'Real AI video from a description');
  await wait(700);
  await fill('#av-desc', 'Kira sits at an outdoor café in Paris with her fluffy Alaskan Malamute. The camera slowly moves towards her; she strokes the dog, sips her coffee and smiles at the camera. Warm afternoon light, real and candid.');
  await wait(500);
  await snap('studio-ai-video');
  await click('button', 'Cancel');
  await wait(500);
  await click('.studio-bar button', 'New');
  await wait(500);
  await click('button', 'Narrated video from a script');
  await wait(600);
  await click('button', 'Use the example');
  await wait(700);
  await snap('studio-narrated');
  await click('[role=tab]', 'Characters');
  await wait(700);
  await click('.character-card', 'Kira');
  await wait(700);
  await snap('studio-characters');
  await click('[role=tab]', 'Script');
  await wait(300);
  await click('button', 'Cancel');
  await wait(500);
  await click('.studio-bar button', 'New');
  await wait(500);
  await click('button', 'Clone a video with your character');
  await wait(800);
  await snap('studio-clone');
  await click('button', 'Cancel');
  await wait(500);
  await nav('Builds');
  await wait(800);
  await snap('builds');
  await click('button', 'Build something');
  await wait(500);
  await fill('.build-request textarea', 'A motion website for my real estate agency: Buy, Rent and Sell sections with property listings, a property page, smooth scroll animations, and a contact form that saves messages.');
  await wait(400);
  await snap('builds-request');
  await click('.build-request button', 'Cancel');
  await wait(400);
  // The site Keo built, as a visitor sees it.
  const site = s.builds.list().find((b) => s.builds.pages(b.id).length);
  let siteShot = false;
  if (host && site) {
    const r = await host.check(site.id, '', { waitMs: 4500, width: W, height: H, shotWidth: W });
    if (r.screenshot) {
      fs.writeFileSync(path.join(shots, 'build-site.png'), r.screenshot);
      siteShot = true;
      log.push('build-site');
    }
  }

  // ---------------------------------------------------------------- the tour in Studio
  const all: Scene[] = [
    { shot: 'chat', title: 'Chat', sub: 'Ask in plain words. Keo plans it and does the work.', focus: [0.58, 0.45], seconds: 6, voice: 'Just ask in plain words, and Keo plans it and does the work, right on your computer.' },
    { shot: 'call', title: 'Call', sub: 'Talk to Keo, hands-free.', focus: [0.55, 0.5], seconds: 4.5, voice: 'Prefer to talk? Call Keo and work hands-free.' },
    { shot: 'memory', title: 'Memory', sub: 'Keo remembers what matters to you.', focus: [0.55, 0.4], seconds: 4.5, voice: 'Keo remembers what matters to you: your style, your business, your preferences.' },
    { shot: 'projects', title: 'Projects', sub: 'Goals, decisions and progress, tracked.', focus: [0.6, 0.42], seconds: 4.5, voice: 'And it keeps your projects on track: goals, decisions, blockers and progress.' },
    { shot: 'studio-editor', title: 'Keo Studio', sub: 'A video editor that edits with you.', focus: [0.5, 0.42], seconds: 6, voice: 'This is Keo Studio, a full video editor. Ask Keo for captions, motion graphics, effects or a whole edit, and watch it happen.' },
    { shot: 'studio-home', title: 'Make anything', sub: 'Edit footage, or start from nothing.', focus: [0.5, 0.65], seconds: 4.5, voice: 'No footage? Start from nothing.' },
    { shot: 'studio-ai-video', title: 'Real AI video', sub: 'Describe it. Keo films it with your character’s face.', focus: [0.5, 0.45], seconds: 6, voice: 'Describe a scene, and Keo films it as real AI video, with your own character’s face in every shot.' },
    { shot: 'studio-narrated', title: 'Narrated videos', sub: 'A script becomes voice, pictures and captions.', focus: [0.5, 0.45], seconds: 5, voice: 'Turn a script into a narrated video, with voice, pictures, captions and music.' },
    { shot: 'studio-characters', title: 'Characters', sub: 'Faces and voices that stay the same.', focus: [0.5, 0.55], seconds: 5, voice: 'Create characters once: their faces and voices stay the same in every video. Even your own voice.' },
    { shot: 'studio-clone', title: 'Clone a video', sub: 'Your character performs any video’s moves.', focus: [0.5, 0.5], seconds: 5, voice: 'And clone any video: your character performs the same moves, in the same place.' },
    { shot: 'builds', title: 'Builds', sub: 'Websites, apps and games, with their backend.', focus: [0.6, 0.35], seconds: 5, voice: 'Keo also builds. Websites, web apps and games, complete with their backend and database.' },
    { shot: 'builds-request', title: 'Just describe it', sub: 'Keo plans, builds, tests and fixes.', focus: [0.5, 0.45], seconds: 5, voice: 'Just describe it. Keo plans every page, builds it, tests it and fixes what it finds.' },
    ...(siteShot ? [{ shot: 'build-site', title: 'Built by Keo', sub: 'A real site, ready to put online.', focus: [0.5, 0.35] as [number, number], seconds: 6, voice: 'A real site, built by Keo, ready to put online, with a clear list of anything only you can do.' }] : []),
  ];
  const scenes = all.filter((sc) => fs.existsSync(path.join(shots, `${sc.shot}.png`)));

  const p = s.studio.create('Keo — product tour', 'landscape');
  const id = p.id;
  s.studio.edit(id, [{ op: 'set_project', name: 'Keo — product tour', width: 1920, height: 1080, fps: 30, background: '#06060A' }]);
  const files = scenes.map((sc) => path.join(shots, `${sc.shot}.png`));
  const whoosh = path.join(out, 'whoosh.wav');
  fs.writeFileSync(whoosh, sfxWav('whoosh'));
  const riser = path.join(out, 'riser.wav');
  fs.writeFileSync(riser, sfxWav('riser'));
  const ding = path.join(out, 'ding.wav');
  fs.writeFileSync(ding, sfxWav('ding'));
  const imported = (await s.studio.importFiles(id, [...files, whoosh, riser, ding])).added;
  const assetOf = (file: string) => imported.find((a) => path.resolve(a.path).toLowerCase() === path.resolve(file).toLowerCase() || a.name === path.basename(file));
  const INTRO = 3.5;
  const OUTRO = 4;
  const ops: EditOp[] = [];
  // Intro: the name, then the promise.
  ops.push({ op: 'add_text', text: 'KEO', start: 0.3, duration: INTRO - 0.5, animIn: 'zoom', animOut: 'fade', style: { sizePct: 16, weight: 'black', letterSpacing: 0.4, color: '#FFFFFF', color2: '#A78BFF', glow: 30, glowColor: '#8B6BFF' }, transform: { y: 0.44 } } as EditOp);
  ops.push({ op: 'add_text', text: 'The AI that works on your computer', start: 1.1, duration: INTRO - 1.3, animIn: 'words', animOut: 'fade', style: { sizePct: 3.4, weight: 'bold', color: '#C9C2FF' }, transform: { y: 0.6 } } as EditOp);
  let at = INTRO;
  const voice: string[] = ['# Keo — product tour: voice-over script', '', 'Read each line while its scene is on screen (times are from the start of the video).', '', `**0:00 – 0:0${Math.round(INTRO)} · Intro** — Meet Keo: the AI that works on your computer.`];
  const mmss = (t: number) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
  for (const sc of scenes) {
    const a = assetOf(path.join(shots, `${sc.shot}.png`));
    if (!a) continue;
    const [fx, fy] = sc.focus;
    ops.push({
      op: 'add_media',
      assetId: a.id,
      start: at,
      duration: sc.seconds,
      fit: 'contain',
      // The app in a floating window, a little smaller than the frame, room for the title below.
      transform: { scale: 0.8, y: 0.45 },
      mask: { shape: 'rounded', radius: 0.02 },
      shadow: 40,
      zooms: [
        { at: 0, scale: 1, x: 0.5, y: 0.5, ease: 'cut' },
        { at: sc.seconds, scale: 1.18, x: fx, y: fy, ease: 'ramp' },
      ],
    } as EditOp);
    ops.push({ op: 'add_text', text: sc.title, start: at + 0.35, duration: sc.seconds - 0.5, animIn: 'slide-up', animOut: 'fade', style: { sizePct: 4.6, weight: 'black', color: '#FFFFFF' }, transform: { y: 0.885 } } as EditOp);
    ops.push({ op: 'add_text', text: sc.sub, start: at + 0.6, duration: sc.seconds - 0.75, animIn: 'fade', animOut: 'fade', style: { sizePct: 2.6, weight: 'normal', color: '#BDB6E8' }, transform: { y: 0.94 } } as EditOp);
    voice.push(`**${mmss(at)} – ${mmss(at + sc.seconds)} · ${sc.title}** — ${sc.voice}`);
    at += sc.seconds;
  }
  const end = at;
  ops.push({ op: 'add_text', text: 'KEO', start: end + 0.2, duration: OUTRO - 0.2, animIn: 'zoom', style: { sizePct: 14, weight: 'black', letterSpacing: 0.4, color: '#FFFFFF', color2: '#A78BFF', glow: 30, glowColor: '#8B6BFF' }, transform: { y: 0.44 } } as EditOp);
  ops.push({ op: 'add_text', text: 'Your work, done.', start: end + 0.9, duration: OUTRO - 0.9, animIn: 'words', style: { sizePct: 3.6, weight: 'bold', color: '#C9C2FF' }, transform: { y: 0.6 } } as EditOp);
  voice.push(`**${mmss(end)} – ${mmss(end + OUTRO)} · Outro** — Keo. Your work, done.`);
  s.studio.edit(id, ops);

  // Slides between the screens, and a whoosh with each.
  const now = s.studio.get(id);
  const clips = now.tracks.flatMap((t) => t.clips).filter((c) => c.type === 'media' && imported.some((a) => a.id === c.assetId && a.kind === 'image')).sort((a, b) => a.start - b.start);
  const sound: EditOp[] = [];
  const w = assetOf(whoosh);
  const r = assetOf(riser);
  const dg = assetOf(ding);
  clips.forEach((c, i) => {
    if (i > 0) sound.push({ op: 'set', clip: c.id, transition: { kind: i % 3 === 0 ? 'zoom' : 'push', seconds: 0.6 } } as EditOp);
    if (w) sound.push({ op: 'add_audio', assetId: w.id, start: Math.max(0, c.start - 0.3), trackName: 'Effects', volume: 0.45 } as EditOp);
  });
  if (r) sound.push({ op: 'add_audio', assetId: r.id, start: 0.2, trackName: 'Effects', volume: 0.5 } as EditOp);
  if (dg) sound.push({ op: 'add_audio', assetId: dg.id, start: end + 0.2, trackName: 'Effects', volume: 0.5 } as EditOp);
  s.studio.edit(id, sound);

  // Frames to look at before the export (the push-in, a title, a slide).
  const review = path.join(out, 'review');
  fs.mkdirSync(review, { recursive: true });
  for (const t of [1.5, INTRO + 1, INTRO + 5.5, INTRO + 6.2, end - 2, end + 2]) fs.writeFileSync(path.join(review, `t${t.toFixed(1)}.png`), await s.studio.framePng(id, t));

  const made = await s.studio.exportVideo(id, { quality: 'best', name: 'Keo product tour' });
  const mp4 = path.join(out, 'Keo product tour.mp4');
  fs.copyFileSync(made.file, mp4);
  voice.push('', `Total length: ${mmss(end + OUTRO)}. Record it in Keo Studio: import the video, open the Audio tab and press Record, or record each scene and drop it at its time.`);
  fs.writeFileSync(path.join(out, 'Voice-over script.md'), voice.join('\n'));
  return { shots: log, scenes: scenes.length, seconds: end + OUTRO, video: mp4, exported: made.file, frames: made.frames };
}
