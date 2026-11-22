import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyStep, sceneProblems, sceneSeconds, startState, stepStates, VisualScene } from '../src/shared/scene';
import type { ChatRequest, ChatResult } from '../src/main/providers/types';
import { visualCapabilities } from '../src/main/capabilities/visual';
import { VisualStore } from '../src/main/visual/visualStore';
import { applyEdits, newProject } from '../src/shared/studio';
import { HOUSE_SCENE } from './fixtures/houseScene';
import { PLANE_SCENE } from './fixtures/planeScene';
import { makeHarness, tempDir, type Harness } from './helpers';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

const reply = (text: string): ChatResult => ({ text, toolCalls: [], stopReason: 'end', usage: { inputTokens: 1, outputTokens: 1 }, model: 'x', native: undefined });
const show = (scene: unknown): ChatResult => ({ text: '', toolCalls: [{ id: 'v1', name: 'visual__explain', input: scene }], stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 }, model: 'x', native: undefined });
const toolResults = (req: ChatRequest) =>
  req.messages
    .flatMap((m) => m.content)
    .filter((b) => b.type === 'tool_result')
    .map((b) => (b as { content: string }).content);

describe('a visual explanation as data', () => {
  it('reads a scene a model wrote, fills in the defaults, and works out where everything is at each step', () => {
    const scene = VisualScene.parse(PLANE_SCENE);
    expect(sceneProblems(scene)).toEqual([]);
    expect(scene.objects.find((o) => o.id === 'wing-right')).toMatchObject({ opacity: 1, hidden: false, glow: false, rot: [0, 0, 0] });
    expect(sceneSeconds(scene)).toBe(28);
    const states = stepStates(scene);
    // One state before each step, and one after the last.
    expect(states).toHaveLength(scene.steps.length + 1);
    expect(states[0]!.plane!.at).toEqual([-12, 1.5, 0]);
    // A move carries over to the steps after it until something moves the part again.
    expect(states[2]!.plane!.at).toEqual([14, 1.5, 0]);
    expect(states[3]!.plane!.at).toEqual([26, 1.5, 0]);
    expect(states[5]!.plane).toMatchObject({ at: [58, 12, 0], rot: [0, 0, 74] });
    // Shown in its step, hidden again when a later step says so.
    expect(states[0]!.thrust!.hidden).toBe(true);
    expect(states[1]!.thrust!.hidden).toBe(false);
    expect(states[2]!.thrust!.hidden).toBe(true);
    // The start is never changed by working out the steps.
    expect(startState(scene).plane!.at).toEqual([-12, 1.5, 0]);
  });

  it('a spin lasts for its own step only; a move changes only what it names', () => {
    const scene = VisualScene.parse({ title: 'Fan', objects: [{ id: 'blade', shape: 'box', color: '#ff0000' }], steps: [{ title: 'Spin', say: 'The blade turns.', moves: [{ id: 'blade', spin: [0, 360, 0], color: '#00ff00' }] }, { title: 'Stop', say: 'It stops.' }] });
    const a = applyStep(startState(scene), scene.steps[0]!);
    expect(a.blade).toMatchObject({ spin: [0, 360, 0], color: '#00ff00', at: [0, 0.5, 0], opacity: 1 });
    const b = applyStep(a, scene.steps[1]!);
    expect(b.blade).toMatchObject({ spin: [0, 0, 0], color: '#00ff00' });
  });

  it('says in plain words what is wrong with a scene that cannot be drawn', () => {
    const bad = VisualScene.parse({
      title: 'Broken',
      objects: [
        { id: 'a', shape: 'box', parent: 'b' },
        { id: 'b', shape: 'box', parent: 'a' },
        { id: 'a', shape: 'sphere' },
        { id: 'pipe', shape: 'tube' },
        { id: 'lost', shape: 'box', parent: 'nowhere' },
      ],
      steps: [{ title: 'Go', say: 'Things move.', moves: [{ id: 'ghost', at: [0, 1, 0] }], focus: ['nobody'] }],
    });
    const said = sceneProblems(bad).join('\n');
    for (const part of ['Two objects are called "a"', 'its own parent', '"pipe" is a tube: give it points', 'the parent "nowhere"', 'moves "ghost"', 'points at "nobody"']) expect(said).toContain(part);
    // The shape of the data is checked before that: no code, no unknown shapes, no stray fields.
    expect(VisualScene.safeParse({ title: 'x', objects: [{ id: 'a', shape: 'dragon' }], steps: [{ title: 't', say: 's' }] }).success).toBe(false);
    expect(VisualScene.safeParse({ title: 'x', objects: [{ id: 'a', shape: 'box', onclick: 'alert(1)' }], steps: [{ title: 't', say: 's' }] }).success).toBe(false);
    expect(VisualScene.safeParse({ title: 'x', objects: [{ id: 'a', shape: 'box', color: 'url(javascript:1)' }], steps: [{ title: 't', say: 's' }] }).success).toBe(false);
    expect(VisualScene.safeParse({ title: 'x', objects: [], steps: [] }).success).toBe(false);
  });
});

describe('scenes that look real', () => {
  it('reads an architect’s house: walls with window openings, a pitched roof, glass, materials, trees and a person for scale', () => {
    const scene = VisualScene.parse(HOUSE_SCENE);
    expect(sceneProblems(scene)).toEqual([]);
    expect(scene.objects.find((o) => o.id === 'wall-front')).toMatchObject({ shape: 'wall', material: 'brick' });
    expect(scene.objects.find((o) => o.id === 'wall-front')!.openings).toHaveLength(3);
    expect(scene.objects.find((o) => o.id === 'window-1')!.material).toBe('glass');
    // What is not said gets a sensible start: daylight, a floor, a painted surface.
    const plain = VisualScene.parse({ title: 'x', objects: [{ id: 'a', shape: 'box' }], steps: [{ title: 't', say: 's' }] });
    expect(plain).toMatchObject({ background: 'sky', ground: 'floor' });
    expect(plain.objects[0]!.material).toBe('painted');
    // The house is built in stages: each part is hidden until its step sets it in place.
    const states = stepStates(scene);
    expect(states[0]!.roof!.hidden).toBe(true);
    expect(states[3]!.roof!.hidden).toBe(false);
    expect(states[5]!['window-1']!.hidden).toBe(false);
  });

  it('is drawn the architect’s way: a build reveal or a white model, or realistic when nothing is said', () => {
    expect(VisualScene.parse(HOUSE_SCENE).style).toBe('reveal');
    expect(VisualScene.parse({ title: 'x', objects: [{ id: 'a', shape: 'box' }], steps: [{ title: 't', say: 's' }] }).style).toBe('real');
    expect(VisualScene.parse({ title: 'x', style: 'clay', objects: [{ id: 'a', shape: 'box' }], steps: [{ title: 't', say: 's' }] }).style).toBe('clay');
    expect(VisualScene.safeParse({ title: 'x', style: 'cartoon', objects: [{ id: 'a', shape: 'box' }], steps: [{ title: 't', say: 's' }] }).success).toBe(false);
  });

  it('keeps a photoreal picture without overwriting an earlier one, under a safe name', () => {
    const root = tempDir('keo-renders-');
    const s = new VisualStore(() => root);
    const a = s.saveRender(Buffer.from('png-a'), 'The Okafor house: front / garden?');
    const b = s.saveRender(Buffer.from('png-b'), 'The Okafor house: front / garden?');
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(path.join(root, 'Renders'));
    expect(path.basename(a)).toBe('The Okafor house front garden.png');
    expect(path.basename(b)).toBe('The Okafor house front garden (2).png');
    expect(fs.readFileSync(a, 'utf8')).toBe('png-a');
  });

  it('says what a new kind of part is missing', () => {
    const bad = VisualScene.parse({
      title: 'x',
      objects: [
        { id: 'beam', shape: 'extrude' },
        { id: 'tank', shape: 'lathe' },
        { id: 'car', shape: 'model' },
        { id: 'front', shape: 'wall', size: [4, 3, 0.2], openings: [{ x: 3, y: 0, w: 2, h: 2 }] },
      ],
      steps: [{ title: 't', say: 's' }],
    });
    const said = sceneProblems(bad).join('\n');
    for (const part of ['"beam" is a extrude: give it an outline', '"tank" is a lathe: give it an outline', '"car" is a model: name the model', 'reaches outside the wall']) expect(said).toContain(part);
    expect(VisualScene.safeParse({ title: 'x', objects: [{ id: 'a', shape: 'box', material: 'gold-plated' }], steps: [{ title: 't', say: 's' }] }).success).toBe(false);
    expect(VisualScene.safeParse({ title: 'x', objects: [{ id: 'a', shape: 'model', model: '../secret' }], steps: [{ title: 't', say: 's' }] }).success).toBe(false);
  });
});

describe('realistic models, guides and Studio', () => {
  const ctx = { signal: new AbortController().signal } as never;
  const store = () => {
    const root = tempDir('keo-visuals-');
    return new VisualStore(() => root);
  };

  it('a realistic model costs credits and asks first; a scene may use it only once it exists', async () => {
    const s = store();
    let made = 0;
    const caps = visualCapabilities({ store: s, model3d: { make: async () => (made++, Buffer.from('glTF fake')), unavailable: () => null, costLabel: 'about 100 Studio credits' } });
    const model = caps.find((c) => c.id === 'visual.model')!;
    const explain = caps.find((c) => c.id === 'visual.explain')!;
    expect(model.approval).toBe('always');
    const input = model.input.parse({ name: 'jet-engine', prompt: 'a turbofan jet engine, brushed metal, cutaway' });
    expect(model.preview(input as never, {} as never).consequences[0]).toContain('100 Studio credits');
    const scene = { title: 'Engine', objects: [{ id: 'engine', shape: 'model', model: 'jet-engine', size: [3, 2, 2] }], steps: [{ title: 'Look', say: 'This is the engine.' }] };
    await expect(explain.execute(explain.input.parse(scene) as never, ctx)).rejects.toThrow(/no model called "jet-engine"/);
    await model.execute(input as never, ctx);
    expect(made).toBe(1);
    expect(s.readModel('jet-engine')?.toString()).toBe('glTF fake');
    expect(s.readModel('../../etc/passwd')).toBeNull();
    await expect(explain.execute(explain.input.parse(scene) as never, ctx)).resolves.toMatchObject({ shown: true });
    // Without Keo Cloud or a key it says how to turn it on.
    const off = visualCapabilities({ store: s }).find((c) => c.id === 'visual.model')!;
    expect(off.unavailableReason?.({} as never)).toContain('Keo Cloud');
  });

  it('teaches like a technical poster: callouts with notes, x-ray casings, exploded views carry over between steps', () => {
    const scene = VisualScene.parse({
      title: 'Engine',
      objects: [
        { id: 'casing', shape: 'cylinder', shell: true, label: 'Casing', note: 'Holds everything in line' },
        { id: 'fan', shape: 'cylinder', label: 'Fan', note: 'Pulls in air', apart: [0, 0, -3] },
        { id: 'shaft', shape: 'cylinder' },
      ],
      steps: [
        { title: 'Whole', say: 'The whole engine.', callouts: 'all' },
        { title: 'Inside', say: 'Seen through the casing.', view: 'xray' },
        { title: 'Apart', say: 'Pulled apart.', explode: true },
        { title: 'Fan', say: 'The fan.', focus: ['fan'] },
        { title: 'Together', say: 'Back together, solid again.', explode: false, view: 'normal' },
      ],
    });
    const st = stepStates(scene);
    expect(st.map((s) => s.fan!.xray)).toEqual([0, 0, 1, 1, 1, 0]);
    expect(st.map((s) => s.fan!.apart)).toEqual([0, 0, 0, 1, 1, 0]);
    expect(sceneProblems(scene)).toEqual([]);
    // An x-ray needs a casing to see through, and an exploded view needs parts that come apart.
    const bare = VisualScene.parse({ title: 'x', objects: [{ id: 'a', shape: 'box' }], steps: [{ title: 't', say: 's', view: 'xray', explode: true }] });
    expect(sceneProblems(bare).join(' ')).toMatch(/no object is a shell.*no object has "apart"/);
  });

  it('makes an object in parts: a few at a time, reusing the library for free, keeping what worked when one part fails', async () => {
    const s = store();
    s.saveModel('engine-fan', Buffer.from('glTF old fan'));
    const asked: string[] = [];
    let running = 0;
    let most = 0;
    const caps = visualCapabilities({
      store: s,
      model3d: {
        make: async (prompt) => {
          asked.push(prompt);
          running++;
          most = Math.max(most, running);
          await new Promise((r) => setTimeout(r, 20));
          running--;
          if (prompt.includes('nozzle')) throw new Error('the 3D service was busy');
          return Buffer.from('glTF part');
        },
        unavailable: () => null,
        costLabel: 'about 100 Studio credits',
      },
    });
    const parts = caps.find((c) => c.id === 'visual.model_parts')!;
    const library = caps.find((c) => c.id === 'visual.models')!;
    const input = parts.input.parse({
      subject: 'turbofan jet engine',
      style: 'photoreal aerospace, brushed titanium, studio light',
      parts: ['fan', 'compressor', 'combustor', 'turbine', 'nozzle'].map((n) => ({ name: `engine-${n}`, prompt: `the ${n} of a jet engine, detailed` })),
    });
    const preview = parts.preview(input as never, {} as never);
    expect(preview.consequences[0]).toMatch(/^4 new parts.*100 Studio credits/);
    expect(preview.consequences[1]).toMatch(/1 part reused from your library for free/);
    const out = (await parts.execute(input as never, ctx)) as { made: string[]; reused: string[]; failed: Array<{ name: string }> };
    expect(out.reused).toEqual(['engine-fan']);
    expect(out.made.sort()).toEqual(['engine-combustor', 'engine-compressor', 'engine-turbine']);
    expect(out.failed.map((f) => f.name)).toEqual(['engine-nozzle']);
    expect(asked).toHaveLength(4); // the fan was not made again
    expect(most).toBeLessThanOrEqual(3); // a few at a time
    expect(asked[0]).toMatch(/One part of a turbofan jet engine.*shown entirely on its own.*photoreal aerospace/);
    expect(s.readModel('engine-fan')?.toString()).toBe('glTF old fan');
    const lib = (await library.execute({} as never, ctx)) as { models: Array<{ name: string }> };
    expect(lib.models.map((m) => m.name)).toEqual(['engine-combustor', 'engine-compressor', 'engine-fan', 'engine-turbine']);
    // All parts already there: free, and needs no approval beyond routine.
    const again = parts.input.parse({ ...input, parts: input.parts.filter((p: { name: string }) => p.name !== 'engine-nozzle') });
    expect(parts.autonomy?.(again as never)).toMatchObject({ tier: 'routine' });
  });

  it('a website guide is put together from pictures taken of the real page, each with its outlined place', async () => {
    const s = store();
    const guide = visualCapabilities({ store: s }).find((c) => c.id === 'visual.guide')!;
    const a = s.saveShot(Buffer.from('png-1'), { url: 'https://shop.test/signup', title: 'Sign up', box: { x: 0.4, y: 0.3, w: 0.2, h: 0.05 } });
    const b = s.saveShot(Buffer.from('png-2'), { url: 'https://shop.test/signup', title: 'Sign up', box: null });
    const out = (await guide.execute(
      guide.input.parse({ title: 'Create your account', site: 'https://shop.test/signup', steps: [{ title: 'Your email', say: 'Type your email in the first box.', shot: a.id }, { title: 'Send', say: 'Press Create account.', shot: b.id }, { title: 'Confirm', say: 'Open the email you get and click the link.' }] }) as never,
      ctx,
    )) as { guide: { steps: Array<{ shot?: string; box?: unknown }> }; pictures: number };
    expect(out.pictures).toBe(2);
    expect(out.guide.steps[0]).toMatchObject({ shot: a.id, box: { x: 0.4, y: 0.3, w: 0.2, h: 0.05 } });
    expect(out.guide.steps[1]!.box).toBeUndefined();
    expect(out.guide.steps[2]!.shot).toBeUndefined();
    expect(s.readShot(a.id)?.toString()).toBe('png-1');
    // A picture that was never taken cannot be named.
    await expect(guide.execute(guide.input.parse({ title: 'x', steps: [{ title: 't', say: 's', shot: 'gs_0000000000' }] }) as never, ctx)).rejects.toThrow(/does not exist/);
  });

  it('a scene becomes a Keo Studio clip as long as the explanation, and a 3D clip without a scene is refused', () => {
    const scene = VisualScene.parse(HOUSE_SCENE);
    const p = newProject({ name: 'House', format: 'landscape' });
    const r = applyEdits(p, [{ op: 'add_motion', piece: 'scene3d', place: 'auto', text: scene.title, start: 0, visual: scene }]);
    const clip = r.project.tracks.flatMap((t) => t.clips).find((c) => c.type === 'motion');
    expect(clip).toMatchObject({ type: 'motion', piece: 'scene3d', start: 0, duration: sceneSeconds(scene) });
    expect(clip?.type === 'motion' && clip.visual?.objects.length).toBe(scene.objects.length);
    expect(() => applyEdits(p, [{ op: 'add_motion', piece: 'scene3d', place: 'auto', text: 'x', start: 0 }])).toThrow(/needs visual/);
  });

  it('asked for by voice or from another app (not in the main chat), the explanation goes to the results panel', async () => {
    h = makeHarness({ script: (_req, n) => (n === 0 ? show(PLANE_SCENE) : reply('Here it is.')) });
    const quick = h.services.conversations.create();
    h.services.settings.update({ commandBar: { conversationId: quick.id } });
    expect(h.services.visuals.latest()).toBeNull();
    await h.services.agent.send(quick.id, 'explain how a plane takes off').done;
    expect(h.services.visuals.latest()?.scene?.title).toBe('How a plane takes off');
    // In the main chat the box is right there in the reply: the panel is left alone.
    const chat = h.services.conversations.create();
    h.provider.setScript((_req, n) => (n === 0 ? show(HOUSE_SCENE) : reply('Here it is.')));
    await h.services.agent.send(chat.id, 'show me the house').done;
    expect(h.services.visuals.latest()?.scene?.title).toBe('How a plane takes off');
  });
});

describe('Keo shows a 3D explanation in the chat', () => {
  it('the scene reaches the chat with the reply; the model gets a short receipt, not its own scene back', async () => {
    const seen: ChatRequest[] = [];
    h = makeHarness({
      script: (req, n) => {
        seen.push(req);
        return n === 0 ? show(PLANE_SCENE) : reply('Thrust builds speed, the wings make lift, and the nose rises.');
      },
    });
    // It is one of the tools Keo always has, with no permission to turn on.
    expect(h.services.registry.toolSpecs().map((t) => t.name)).toContain('visual__explain');
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'explain how a plane takes off').done;
    const step = msg.meta.tools![0]!;
    expect(step).toMatchObject({ capabilityId: 'visual.explain', outcome: 'executed' });
    expect(step.visual?.title).toBe('How a plane takes off');
    expect(step.visual?.steps).toHaveLength(5);
    expect(step.visual?.objects.find((o) => o.id === 'plane')?.label).toBe('Fuselage');
    const result = toolResults(seen[1]!).join('\n');
    expect(result).toContain('(shown to the user)');
    expect(result).not.toContain('Fuselage');
    expect(msg.content).toContain('wings make lift');
    // Nothing on the computer was touched and nothing needed approving.
    expect(h.desktop.inputCalls()).toHaveLength(0);
    expect(h.services.tasks.list(5).filter((t) => t.state === 'awaiting_authorization')).toHaveLength(0);
  });

  it('a scene that points at parts that do not exist is sent back to be fixed, and nothing is shown', async () => {
    const seen: ChatRequest[] = [];
    const broken = { title: 'Engine', objects: [{ id: 'piston', shape: 'cylinder' }], steps: [{ title: 'Push', say: 'The piston goes down.', moves: [{ id: 'crank', rot: [0, 0, 90] }] }] };
    h = makeHarness({
      script: (req, n) => {
        seen.push(req);
        return n === 0 ? show(broken) : reply('I could not draw that yet.');
      },
    });
    const c = h.services.conversations.create();
    const msg = await h.services.agent.send(c.id, 'show me how an engine works').done;
    expect(msg.meta.tools![0]).toMatchObject({ capabilityId: 'visual.explain', outcome: 'failed' });
    expect(msg.meta.tools![0]!.visual).toBeUndefined();
    expect(toolResults(seen[1]!).join('\n')).toContain('moves \\"crank\\", which is not an object');
  });
});
