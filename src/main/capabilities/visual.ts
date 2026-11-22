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
  'A part with parent moves and turns with its parent, and its "at" is measured from the parent\'s centre (wheels on a car, floors on a building). Use 20–100 objects: detail is what makes it look real (window glass, door, chimney, path, trees, a person for scale).',
  'background: sky (daylight, default), sunset, night, or light / dark (a plain studio for products and machines). ground: grass, concrete, asphalt, floor, grid, none.',
  'style: "reveal" for anything being BUILT or ASSEMBLED (a house, a skyscraper, a bridge, a machine put together): the parts still to come show as clean sketch lines and fill in as their step builds them, people are white figures — the look architects show clients. "clay" for a design shown as a white model (form and light, no materials). "real" (default) for how something works or moves. In "reveal", every part that gets built starts hidden: true at its final place.',
  'When the user wants it, the viewer can also make a photoreal picture of the finished result (a button in the player; it costs a little): mention it in one short sentence for designs and buildings.',
  'TEACH, do not just describe — like the best teacher with a cutaway model on the desk. For "how does X work" use 6–12 steps in this order: (1) an overview of the whole thing with callouts: "all" (every labelled part named at once); (2) the inside: an x-ray (view: "xray") or an exploded view (explode: true) so the parts show; (3) one step per important part — what it is, what it does and HOW it does it, with numbers where they help ("the fan moves about 90% of the air"); (4) the parts working together in order (air in → squeezed → burned → spins the turbine → pushed out), with the parts spinning and glowing arrows for the flow; (5) a short recap of the key idea. Say in plain words, two to four sentences per step (it is read aloud), building on the step before.',
  'steps: each has title, say (shown as the caption AND read aloud, so it describes exactly what happens in this step), seconds (about 3 s per sentence), focus (ids of the parts this step is about: they glow softly, the camera goes to them, and their callouts show), callouts ("focus" default, "all" for an overview, "none"), view ("xray" turns every shell part into see-through blue glass with glowing edges so the inside shows; "normal" makes it solid again; carries over), explode (true slides every part with "apart" out to at + apart; false brings them back; carries over) and moves: where parts end up ({id, at, rot, scale, color, opacity, hidden, spin}). Moves carry over. Parts that are hidden: true at the start and get hidden: false in a step are set down into place (building or assembling). spin keeps a part turning during its step (degrees per second). Every step should change something the user can see.',
  'Labels are callouts like a technical poster: every part the user should learn gets a label (2–3 words, e.g. "Fan blades") AND a note (one line on what it does, e.g. "Pulls in air; most of it bypasses the core for thrust"). Casings, skins and covers get shell: true so an x-ray can see through them. Parts that come apart get apart: [x, y, z], the direction and distance they slide out in an exploded view (along the length of an engine, out from a body), in metres.',
  'Realism: for a machine, vehicle, organ or product the user wants to really understand, make its main parts as realistic models with visual__model_parts (check visual__models first: parts made before are free) and place each part where it sits in the real object, with the casing as a shell. Fill in small details (bolts, pipes, arrows for air and fuel flow) with shapes. Buildings, rooms and diagrams are better built from shapes.',
  'The camera follows the parts in focus by itself; give a step its own camera {from, to} for a better angle (walk around the thing over the steps). Set the opening camera so the whole thing is in view.',
  'Keep the motion true to how the thing really works; simplify, never invent. After the tool, add a short written lesson in the reply (the key idea and the parts in a few lines, so the user can read it again); do not repeat every caption.',
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

  const PartName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,47}$/);
  const parts = defineCapability({
    ...base,
    id: 'visual.model_parts',
    risk: 'medium',
    title: 'Make a realistic object in parts',
    description:
      'For a detailed, realistic teaching explanation (how a jet engine, an airliner, a car engine, the heart works): make the object\'s main parts as SEPARATE realistic 3D models, in one consistent style, so each part can be labelled, glow, be pulled apart (exploded view) and move on its own in visual__explain. Give the subject, one style line shared by every part ("photoreal aerospace engineering, brushed titanium and white composite, studio lighting"), and 3–10 parts, each with a name (saved as is: prefix it with the subject, e.g. "jet-engine-fan") and a prompt describing that part ALONE as a product photographer would (shape, material, details), never a whole scene, brand or logo. Parts already in the library (visual__models) are reused for free: check it first and use the same names. Making each new part costs Studio credits and takes a few minutes (they are made a few at a time); the user approves the whole set once. Then build the scene with each part as { shape: "model", model: name, size, at } and a shell part for the casing.',
    input: z
      .object({
        subject: z.string().trim().min(2).max(120),
        style: z.string().trim().min(5).max(300),
        parts: z
          .array(z.object({ name: PartName, prompt: z.string().trim().min(10).max(800) }).strict())
          .min(1)
          .max(10)
          .refine((ps) => new Set(ps.map((p) => p.name)).size === ps.length, 'Every part needs its own name.'),
      })
      .strict(),
    output: z.object({ made: z.array(z.string()), reused: z.array(z.string()), failed: z.array(z.object({ name: z.string(), error: z.string() })), use: z.string() }),
    approval: 'always',
    consequential: true,
    idempotent: true,
    timeoutMs: 45 * 60_000,
    verificationPolicy: 'Each model file is saved on this computer.',
    unavailableReason: () => (d.model3d ? d.model3d.unavailable() : 'Making realistic 3D models needs Keo Cloud or your own fal.ai key.'),
    autonomy: (i) => (i.parts.every((p) => d.store.hasModel(p.name)) ? { tier: 'routine' as const } : { tier: 'important' as const, reason: 'it costs Studio credits' }),
    preview: (i) => {
      const fresh = i.parts.filter((p) => !d.store.hasModel(p.name));
      const have = i.parts.length - fresh.length;
      return {
        summary: `Make a realistic ${i.subject} in ${i.parts.length} parts`,
        target: null,
        consequences: [
          fresh.length ? `${fresh.length} new part${fresh.length > 1 ? 's' : ''}: ${fresh.map((p) => p.name).join(', ')} — each costs ${d.model3d?.costLabel ?? 'Studio credits'} (a realistic picture, then the 3D model).` : 'Every part is already in your model library: nothing to pay.',
          ...(have ? [`${have} part${have > 1 ? 's' : ''} reused from your library for free.`] : []),
          'Saved in your model library, so asking about this again later is instant and free.',
        ],
        dataExport: fresh.length ? 'The descriptions and pictures go to fal.ai (through Keo Cloud, or your own fal.ai key).' : null,
      };
    },
    auditView: (i) => ({ parts: i.parts.length }),
    async execute(i, ctx) {
      const why = d.model3d ? d.model3d.unavailable() : 'Making realistic 3D models needs Keo Cloud or your own fal.ai key.';
      const reused = i.parts.filter((p) => d.store.hasModel(p.name)).map((p) => p.name);
      const todo = i.parts.filter((p) => !d.store.hasModel(p.name));
      if (todo.length && (!d.model3d || why)) throw new CapabilityError('unavailable', why ?? 'Not available.', { dispatched: 'no' });
      const made: string[] = [];
      const failed: Array<{ name: string; error: string }> = [];
      // A few at a time: faster than one by one, without flooding the service.
      const queue = [...todo];
      const worker = async () => {
        for (let p = queue.shift(); p && !ctx.signal.aborted; p = queue.shift()) {
          const prompt = `${p.prompt}. One part of a ${i.subject}, shown entirely on its own on a plain neutral background, nothing else in the picture. Style shared by every part: ${i.style}.`;
          try {
            d.store.saveModel(p.name, await d.model3d!.make(prompt, ctx.signal));
            made.push(p.name);
          } catch (e) {
            failed.push({ name: p.name, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, todo.length) }, worker));
      if (!made.length && !reused.length) throw new CapabilityError('model_failed', `No part could be made: ${failed.map((f) => `${f.name}: ${f.error}`).join('; ')}`, { dispatched: 'unknown' });
      return {
        made,
        reused,
        failed,
        use: `In visual__explain, each part is { id, shape: "model", model: "<name>", size: [w, h, d], at: [x, y, z], label, note, apart } — fitted inside size. Place them where they sit in the real object; mark the casing shell: true.${failed.length ? ' Build the failed parts from simple shapes instead.' : ''}`,
      };
    },
  });

  const library = defineCapability({
    ...base,
    id: 'visual.models',
    title: 'List the realistic 3D models made so far',
    description: 'The user\'s model library: every realistic 3D model made before (by visual__model or visual__model_parts), by name. Reusing one is free and instant: check this before making new models, and use the same names.',
    input: z.object({}).strict(),
    output: z.object({ models: z.array(z.object({ name: z.string(), kb: z.number(), made: z.string() })) }),
    approval: 'never',
    consequential: false,
    idempotent: true,
    timeoutMs: 5000,
    verificationPolicy: 'Read from the model folder.',
    autonomy: () => ({ tier: 'routine' }),
    preview: () => ({ summary: 'List the 3D model library', target: null, consequences: [], dataExport: null }),
    auditView: () => ({}),
    async execute() {
      return { models: d.store.models() };
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

  return [explain, model, parts, library, guide];
}
