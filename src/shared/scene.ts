/**
 * A visual explanation: a small 3D scene Keo describes as DATA (objects, labels, and steps that
 * move them while a sentence explains what is happening). Keo's own viewer draws it — in the chat,
 * in the results panel, in Studio. No code written by a model ever runs to show one.
 *
 * Units are metres-like; y is up and the ground is y = 0. Angles are degrees.
 */
import { z } from 'zod';

const N = z.number().min(-500).max(500);
export const Vec3 = z.tuple([N, N, N]);
export type Vec3 = z.infer<typeof Vec3>;

const Id = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/, 'An id like "wing-left": lower-case letters, digits, - and _');
const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour like #2f6fed');

export const SCENE_SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'wedge', 'tube', 'arrow', 'wall', 'roof', 'extrude', 'lathe', 'tree', 'person', 'model'] as const;

/** What a surface is made of: how it takes the light, and its pattern (bricks, grain, tiles) at real-world size. */
/**
 * How the scene is drawn. real: every part in its own material. reveal: the architect's build
 * look — what is built so far is real, what is still to come shows as thin sketch lines, people
 * are white figures. clay: a white model, every part matte white with soft shade.
 */
export const SCENE_STYLES = ['real', 'reveal', 'clay'] as const;
export type SceneStyle = (typeof SCENE_STYLES)[number];

export const SCENE_MATERIALS = ['painted', 'plastic', 'metal', 'chrome', 'glass', 'concrete', 'brick', 'wood', 'stone', 'tile', 'roof', 'grass', 'water', 'rubber', 'fabric', 'asphalt', 'light'] as const;

const Point2 = z.tuple([N, N]);

export const SceneObject = z
  .object({
    id: Id,
    shape: z.enum(SCENE_SHAPES),
    /** Width, height, depth. A sphere uses the width as its diameter; a tube and an arrow use the width as their thickness. */
    size: Vec3.default([1, 1, 1]),
    /** Where its centre is (relative to its parent when it has one). */
    at: Vec3.default([0, 0.5, 0]),
    rot: Vec3.default([0, 0, 0]),
    color: Color.default('#8aa0b8'),
    material: z.enum(SCENE_MATERIALS).default('painted'),
    opacity: z.number().min(0.05).max(1).default(1),
    /** How rounded a box's edges are, 0 (sharp) to 1 (as round as it can be). Real things are rarely perfectly sharp. */
    round: z.number().min(0).max(1).optional(),
    /**
     * extrude: the outline of the shape seen from the front, as [x, y] points in metres, pushed back by the depth in size.
     * lathe: half the side view as [radius, height] points, spun around the upright axis (a bottle, a tower, an engine).
     */
    outline: z.array(Point2).min(3).max(48).optional(),
    /** wall: holes for windows and doors, each {x, y, w, h} in metres from the wall's bottom-left corner. */
    openings: z.array(z.object({ x: z.number().min(0).max(200), y: z.number().min(0).max(200), w: z.number().min(0.1).max(100), h: z.number().min(0.1).max(100) }).strict()).max(16).optional(),
    /** model: the name a realistic 3D model was saved under (visual__model). It is fitted inside size. */
    model: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/).optional(),
    /** A short name shown next to it when the step points at it. */
    label: z.string().trim().min(1).max(40).optional(),
    /** Moves and turns with this object (a wheel on a car, a floor of a building). */
    parent: Id.optional(),
    hidden: z.boolean().default(false),
    /** Lit from inside: a flame, a lamp, a laser, a signal. */
    glow: z.boolean().default(false),
    /** For a tube or an arrow: the points it runs through (2–12). */
    points: z.array(Vec3).min(2).max(12).optional(),
  })
  .strict();
export type SceneObject = z.infer<typeof SceneObject>;

export const SceneMove = z
  .object({
    id: Id,
    at: Vec3.optional(),
    rot: Vec3.optional(),
    /** Stretch relative to its own size: [1, 2, 1] is twice as tall. */
    scale: z.tuple([z.number().min(0.01).max(50), z.number().min(0.01).max(50), z.number().min(0.01).max(50)]).optional(),
    color: Color.optional(),
    opacity: z.number().min(0).max(1).optional(),
    hidden: z.boolean().optional(),
    /** Keeps turning for the whole step, degrees per second on each axis (a propeller, a roller, a wheel). */
    spin: Vec3.optional(),
  })
  .strict();
export type SceneMove = z.infer<typeof SceneMove>;

const Camera = z.object({ from: Vec3, to: Vec3 }).strict();

export const SceneStep = z
  .object({
    title: z.string().trim().min(1).max(60),
    /** What is happening in this step, in plain words: shown as a caption and read aloud while it moves. */
    say: z.string().trim().min(1).max(420),
    seconds: z.number().min(2).max(20).default(6),
    camera: Camera.optional(),
    moves: z.array(SceneMove).max(30).default([]),
    /** The parts this step is about: they are lit and labelled, the rest is dimmed. */
    focus: z.array(Id).max(12).default([]),
  })
  .strict();
export type SceneStep = z.infer<typeof SceneStep>;

export const VisualScene = z
  .object({
    title: z.string().trim().min(1).max(80),
    /** One line on what the scene shows. */
    about: z.string().trim().max(200).default(''),
    /** The setting: daylight ('sky'), evening ('sunset'), night, or a plain studio ('light', 'dark'). */
    background: z.enum(['dark', 'light', 'sky', 'sunset', 'night']).default('sky'),
    ground: z.enum(['grid', 'floor', 'grass', 'concrete', 'asphalt', 'none']).default('floor'),
    style: z.enum(SCENE_STYLES).default('real'),
    camera: Camera.default({ from: [8, 6, 10], to: [0, 1, 0] }),
    objects: z.array(SceneObject).min(1).max(90),
    steps: z.array(SceneStep).min(1).max(12),
  })
  .strict();
export type VisualScene = z.infer<typeof VisualScene>;

/** A how-to guide on a real web page: pictures of the page, each with the place to act outlined and a sentence saying what to do. */
export const GuideStep = z
  .object({
    title: z.string().trim().min(1).max(70),
    /** What to do in this step, in plain words: shown as the caption and read aloud. */
    say: z.string().trim().min(1).max(420),
    /** The picture of the page for this step (from web__guide_shot). */
    shot: z
      .string()
      .regex(/^gs_[a-z0-9]{6,16}$/)
      .optional(),
    /** Where to look in the picture, as fractions of its width and height (filled in by Keo from the picture). */
    box: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }).strict().optional(),
  })
  .strict();
export type GuideStep = z.infer<typeof GuideStep>;

export const VisualGuide = z
  .object({
    title: z.string().trim().min(1).max(90),
    about: z.string().trim().max(200).default(''),
    /** The page the guide is about. */
    site: z.string().trim().max(300).default(''),
    steps: z.array(GuideStep).min(1).max(14),
  })
  .strict();
export type VisualGuide = z.infer<typeof VisualGuide>;

/** Problems the shape of the data cannot show: a name used twice, a part that points at nothing. Empty when the scene is sound. */
export function sceneProblems(scene: VisualScene): string[] {
  const out: string[] = [];
  const ids = new Set<string>();
  for (const o of scene.objects) {
    if (ids.has(o.id)) out.push(`Two objects are called "${o.id}": every id must be different.`);
    ids.add(o.id);
  }
  const parentOf = new Map(scene.objects.map((o) => [o.id, o.parent] as const));
  for (const o of scene.objects) {
    if (o.parent && !ids.has(o.parent)) out.push(`"${o.id}" has the parent "${o.parent}", which is not an object.`);
    if ((o.shape === 'tube' || o.shape === 'arrow') && !o.points) out.push(`"${o.id}" is a ${o.shape}: give it points (the places it runs through).`);
    if ((o.shape === 'extrude' || o.shape === 'lathe') && !o.outline) out.push(`"${o.id}" is a ${o.shape}: give it an outline (its points).`);
    if (o.shape === 'model' && !o.model) out.push(`"${o.id}" is a model: name the model it shows (made with visual__model).`);
    if (o.shape === 'wall')
      for (const w of o.openings ?? []) if (w.x + w.w > o.size[0] + 0.001 || w.y + w.h > o.size[1] + 0.001) out.push(`An opening of the wall "${o.id}" reaches outside the wall (the wall is ${o.size[0]} long and ${o.size[1]} high).`);
    // A part cannot hang from itself, however long the chain.
    let p = o.parent;
    for (let hops = 0; p && hops <= scene.objects.length; hops++) {
      if (p === o.id) {
        out.push(`"${o.id}" is its own parent (through a chain of parents).`);
        break;
      }
      p = parentOf.get(p);
    }
  }
  scene.steps.forEach((s, i) => {
    for (const m of s.moves) if (!ids.has(m.id)) out.push(`Step ${i + 1} moves "${m.id}", which is not an object.`);
    for (const f of s.focus) if (!ids.has(f)) out.push(`Step ${i + 1} points at "${f}", which is not an object.`);
  });
  return [...new Set(out)].slice(0, 12);
}

/** What one object looks like at a moment: where it is, how it is turned and stretched, its colour. */
export interface ObjectState {
  at: Vec3;
  rot: Vec3;
  scale: Vec3;
  color: string;
  opacity: number;
  hidden: boolean;
  spin: Vec3;
}

export type SceneState = Record<string, ObjectState>;

export function startState(scene: VisualScene): SceneState {
  const s: SceneState = {};
  for (const o of scene.objects) s[o.id] = { at: [...o.at], rot: [...o.rot], scale: [1, 1, 1], color: o.color, opacity: o.opacity, hidden: o.hidden, spin: [0, 0, 0] };
  return s;
}

/** The state once a step has finished: each move changes only what it names; a spin lasts for its own step. */
export function applyStep(before: SceneState, step: SceneStep): SceneState {
  const after: SceneState = {};
  for (const [id, o] of Object.entries(before)) after[id] = { ...o, at: [...o.at], rot: [...o.rot], scale: [...o.scale], spin: [0, 0, 0] };
  for (const m of step.moves) {
    const o = after[m.id];
    if (!o) continue;
    if (m.at) o.at = [...m.at];
    if (m.rot) o.rot = [...m.rot];
    if (m.scale) o.scale = [...m.scale];
    if (m.color) o.color = m.color;
    if (m.opacity !== undefined) o.opacity = m.opacity;
    if (m.hidden !== undefined) o.hidden = m.hidden;
    if (m.spin) o.spin = [...m.spin];
  }
  return after;
}

/** The state at the start of each step, and after the last one (steps.length + 1 entries). */
export function stepStates(scene: VisualScene): SceneState[] {
  const states = [startState(scene)];
  for (const s of scene.steps) states.push(applyStep(states[states.length - 1]!, s));
  return states;
}

/** A small scene to start from in Keo Studio (a planet circling its star). */
export const SAMPLE_SCENE: VisualScene = VisualScene.parse({
  title: 'A planet and its star',
  about: 'A sample 3D scene: change it by asking Keo.',
  background: 'night',
  ground: 'none',
  camera: { from: [0, 7, 15], to: [0, 0.5, 0] },
  objects: [
    { id: 'star', shape: 'sphere', size: [3, 3, 3], at: [0, 1, 0], color: '#ffc04d', material: 'light', label: 'Star' },
    { id: 'orbit', shape: 'torus', size: [14, 0.2, 14], at: [0, 1, 0], color: '#5f6f8f', opacity: 0.5 },
    { id: 'arm', shape: 'sphere', size: [0.1, 0.1, 0.1], at: [0, 1, 0], opacity: 0.05 },
    { id: 'planet', shape: 'sphere', size: [1.2, 1.2, 1.2], at: [7, 0, 0], color: '#3f7fd9', material: 'plastic', parent: 'arm', label: 'Planet' },
  ],
  steps: [
    { title: 'The star', say: 'At the centre is a star, giving off light and heat.', seconds: 4, focus: ['star'] },
    { title: 'The orbit', say: 'The planet circles the star, held on its path by gravity.', seconds: 8, focus: ['planet'], moves: [{ id: 'arm', spin: [0, 45, 0] }] },
  ],
});

/** The realistic models a scene uses (their saved names). */
export function sceneModels(scene: VisualScene): string[] {
  return [...new Set(scene.objects.flatMap((o) => (o.shape === 'model' && o.model ? [o.model] : [])))];
}

/** How long the whole explanation runs, in seconds. */
export function sceneSeconds(scene: VisualScene): number {
  return scene.steps.reduce((n, s) => n + s.seconds, 0);
}
