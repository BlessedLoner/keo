/**
 * Visual explanations: Keo describes a small 3D scene as data and the app's own viewer shows it
 * (a box in the chat that opens big; the steps move in time with their captions and narration).
 * Also: realistic 3D models for those scenes, and how-to guides on real web pages.
 */
import { z } from 'zod';
import { sceneModels, sceneProblems, sceneSeconds, VisualGuide, VisualScene } from '../../shared/scene';
import type { VisualStore } from '../visual/visualStore';
import { CapabilityError, defineCapability, type AnyCapability } from './types';

export interface VisualDeps {
  store: VisualStore;
  /** A realistic 3D model (GLB bytes) from a description; unavailable() says why it cannot be made here. */
  model3d?: { make: (prompt: string, signal: AbortSignal) => Promise<Buffer>; unavailable: () => string | null; costLabel: string };
}

export const VISUAL_HOW_TO = [
  'Show the user a 3D explanation they can watch and turn: how something works, moves or is built (how a plane takes off, how a house or a skyscraper goes up, how a printer prints, how an engine turns, how the heart pumps), or a design shown to a client (an architect\'s house, a product, a room).',
  'Use it when seeing it helps more than reading it, also when the user asks about something they are looking at. Not for plain facts, opinions or lists.',
  'You describe the scene as data; Keo draws it with real light, shadows and materials. Make it look REAL, never like a toy: true proportions in metres (a door is 0.9 × 2.1, a storey 3, a car 4.5 long, a person 1.75 tall), believable colours, and the right material on every part.',
  'y is up, the ground is y = 0, angles are degrees. Each object: id, shape, size [width, height, depth], at [x, y, z] (its centre), color, material.',
  'material: brick, concrete, wood, stone, tile, roof (tiles), glass, metal, chrome, plastic, rubber, fabric, grass, water, asphalt, painted (default), light (shines). Surfaces come at real-world size: bricks are brick-sized on any wall.',
  'shapes: box (edges softly rounded; round 0–1 for more), sphere, cylinder, cone, torus, capsule, plane (a thin sheet), wedge (a ramp); wall (size [length, height, thickness] with openings [{x, y, w, h}] cut for windows and doors, measured from its bottom-left corner — put a glass box in each window opening and a wood box in the door opening); roof (a pitched roof, ridge along the depth); extrude (outline: [x, y] points of the front view, pushed back by the depth — for any profile: a wing, a beam, a gear tooth, a floor plan); lathe (outline: [radius, height] points spun around the upright axis — a bottle, a tank, a tower, a jet engine); tube and arrow (points they run through; glowing arrows for forces, flows and signals, hidden until their step); tree and person (for surroundings and a sense of size); model (a realistic object made with visual__model, fitted inside size).',
  'A part with parent moves and turns with its parent, and its "at" is measured from the parent\'s centre (wheels on a car, floors on a building). Use 20–70 objects: detail is what makes it look real (window glass, door, chimney, path, trees, a person for scale).',
  'background: sky (daylight, default), sunset, night, or light / dark (a plain studio for products and machines). ground: grass, concrete, asphalt, floor, grid, none.',
  'style: "reveal" for anything being BUILT or ASSEMBLED (a house, a skyscraper, a bridge, a machine put together): the parts still to come show as clean sketch lines and fill in as their step builds them, people are white figures — the look architects show clients. "clay" for a design shown as a white model (form and light, no materials). "real" (default) for how something works or moves. In "reveal", every part that gets built starts hidden: true at its final place.',
  'When the user wants it, the viewer can also make a photoreal picture of the finished result (a button in the player; it costs a little): mention it in one short sentence for designs and buildings.',
  'steps: 3–8, in the order things happen. Each has title, say (one or two plain sentences: shown as the caption AND read aloud, so it must describe exactly what happens in this step), seconds, focus (ids of the parts this step is about: they get their labels) and moves: where parts end up ({id, at, rot, scale, color, opacity, hidden, spin}). Moves carry over. Parts that are hidden: true at the start and get hidden: false in a step are set down into place — that is how to show something being built or assembled. spin keeps a part turning during its step (degrees per second). Every step should change something the user can see.',
  'The camera follows the parts in focus by itself; give a step its own camera {from, to} for a better angle (walk around the thing over the steps). Set the opening camera so the whole thing is in view.',
  'Keep the motion true to how the thing really works; simplify, never invent. After the tool, add two or three sentences in the reply; do not repeat every step in text.',
].join(' ');

const GuideInput = VisualGuide.extend({
  steps: z
    .array(
      z
        .object({
          title: z.string().trim().min(1).max(70),
          say: z.string().trim().min(1).max(420),
          shot: z
            .string()
            .regex(/^gs_[a-z0-9]{6,16}$/)
            .optional(),
        })
        .strict(),
    )
    .min(1)
    .max(14),
}).strict();

export function visualCapabilities(d: VisualDeps): AnyCapability[] {
  const base = { version: '1.0.0', risk: 'low' as const, permissions: [], maxAttempts: 1, modelVisible: true };

  const explain = defineCapability({
    ...base,
    id: 'visual.explain',
    title: 'Show a 3D explanation',
    description: VISUAL_HOW_TO,
    input: VisualScene,
    output: z.object({ shown: z.boolean(), title: z.string(), steps: z.number(), objects: z.number(), seconds: z.number(), note: z.string(), scene: VisualScene }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 15_000,
    verificationPolicy: 'The scene is checked (every part and every move points at something real) before it is shown.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Show “${i.title}” in 3D`, target: null, consequences: ['Shown in Keo only; nothing is sent or saved elsewhere.'], dataExport: null }),
    auditView: (i) => ({ objects: i.objects.length, steps: i.steps.length }),
    async execute(i) {
      const problems = sceneProblems(i);
      for (const name of sceneModels(i)) if (!d.store.hasModel(name)) problems.push(`There is no model called "${name}": make it first with visual__model, or use simple shapes.`);
      if (problems.length) throw new CapabilityError('invalid_scene', `The scene cannot be shown yet: ${problems.join(' ')} Fix these and send the whole scene again.`, { dispatched: 'no' });
      return {
        shown: true,
        title: i.title,
        steps: i.steps.length,
        objects: i.objects.length,
        seconds: Math.round(sceneSeconds(i)),
        note: 'The user now sees a box with this explanation; clicking it opens it large, where it plays step by step with your captions read aloud. Add a short summary in your reply.',
        scene: i,
      };
    },
  });

  const model = defineCapability({
    ...base,
    id: 'visual.model',
    risk: 'medium',
    title: 'Make a realistic 3D object for an explanation',
    description:
      'Make one realistic, textured 3D object from a description (Keo makes a studio picture of it with AI, then turns the picture into a 3D model; a few minutes), to use in visual__explain as an object with shape "model" and model: its name. For the things simple shapes cannot show well: a real-looking car, a jet engine, a heart, a sofa, an excavator. Describe one object on its own, as a product photographer would (what it is, style, colour and finish, details); never a real brand or logo, never a whole scene. It costs Studio credits and the user approves each one: use it when realism matters and the user wants it, at most two or three per explanation; buildings, rooms and diagrams are better built from shapes.',
    input: z
      .object({
        name: z
          .string()
          .regex(/^[a-z0-9][a-z0-9_-]{0,47}$/)
          .describe('A short name to save it under, like "jet-engine"'),
        prompt: z.string().trim().min(10).max(1500),
      })
      .strict(),
    output: z.object({ name: z.string(), kb: z.number(), use: z.string() }),
    approval: 'always',
    consequential: true,
    idempotent: true,
    timeoutMs: 15 * 60_000,
    verificationPolicy: 'The model file is saved on this computer.',
    unavailableReason: () => (d.model3d ? d.model3d.unavailable() : 'Making realistic 3D models needs Keo Cloud or your own fal.ai key.'),
    autonomy: () => ({ tier: 'important', reason: 'it costs Studio credits' }),
    preview: (i) => ({
      summary: `Make a realistic 3D ${i.name.replace(/[-_]/g, ' ')}`,
      target: null,
      consequences: [`Costs ${d.model3d?.costLabel ?? 'Studio credits'} (a realistic picture, then the 3D model).`, `Description: “${i.prompt.slice(0, 300)}”`],
      dataExport: 'The description and the picture go to fal.ai (through Keo Cloud, or your own fal.ai key).',
    }),
    auditView: (i) => ({ name: i.name }),
    async execute(i, ctx) {
      const why = d.model3d ? d.model3d.unavailable() : 'Making realistic 3D models needs Keo Cloud or your own fal.ai key.';
      if (!d.model3d || why) throw new CapabilityError('unavailable', why ?? 'Not available.', { dispatched: 'no' });
      let glb: Buffer;
      try {
        glb = await d.model3d.make(i.prompt, ctx.signal);
      } catch (e) {
        throw new CapabilityError('model_failed', e instanceof Error ? e.message : String(e), { dispatched: 'unknown' });
      }
      d.store.saveModel(i.name, glb);
      return { name: i.name, kb: Math.round(glb.length / 1024), use: `In visual__explain: { id, shape: "model", model: "${i.name}", size: [width, height, depth], at: [x, y, z] } — it is fitted inside size.` };
    },
  });

  const guide = defineCapability({
    ...base,
    id: 'visual.guide',
    title: 'Show a how-to guide on a web page',
    description:
      'Show the user a step-by-step guide on a real website: how to find something, sign up, fill a form, change a setting. Each step shows a picture of the real page with the place to act outlined, and your sentence is the caption and is read aloud. First open the page in Keo’s browser window (web__open, then web__read) and take one picture per step with web__guide_shot (ref = the field, button or link of that step). Then call this with steps in order: title, say (exactly what to do: “Click Sign up in the top right corner”, “Type your email here”) and shot. You only LOOK at the pages for a guide: never fill in or submit anything while making one, and never ask for or show passwords. If a step is behind a sign-in you cannot see, say so in that step and leave its shot out.',
    input: GuideInput,
    output: z.object({ shown: z.boolean(), title: z.string(), steps: z.number(), pictures: z.number(), note: z.string(), guide: VisualGuide }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 15_000,
    verificationPolicy: 'Every picture a step names was taken from the page in this session.',
    autonomy: () => ({ tier: 'routine' }),
    preview: (i) => ({ summary: `Show the guide “${i.title}”`, target: null, consequences: ['Shown in Keo only.'], dataExport: null }),
    auditView: (i) => ({ steps: i.steps.length }),
    async execute(i) {
      const missing = i.steps.flatMap((s, n) => (s.shot && !d.store.shot(s.shot) ? [`Step ${n + 1} names the picture "${s.shot}", which does not exist: take it with web__guide_shot first.`] : []));
      if (missing.length) throw new CapabilityError('invalid_guide', `${missing.join(' ')}`, { dispatched: 'no' });
      const steps = i.steps.map((s) => {
        const shot = s.shot ? d.store.shot(s.shot) : null;
        return { title: s.title, say: s.say, ...(s.shot ? { shot: s.shot } : {}), ...(shot?.box ? { box: shot.box } : {}) };
      });
      const out = VisualGuide.parse({ title: i.title, about: i.about, site: i.site, steps });
      return {
        shown: true,
        title: i.title,
        steps: steps.length,
        pictures: steps.filter((s) => s.shot).length,
        note: 'The user now sees a box with this guide; clicking it opens it large and plays it step by step with your captions read aloud. Add one or two sentences in your reply.',
        guide: out,
      };
    },
  });

  return [explain, model, guide];
}
