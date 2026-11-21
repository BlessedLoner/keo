import RAPIER from '@dimforge/rapier3d-compat';
import { describe, expect, it } from 'vitest';

/** The driving kit's car physics, without graphics: a long drive must not wear the car out by itself. */
describe('drive kit car', () => {
  it('drives for 70 seconds on its wheels: no force piles up, no crashes, no damage', async () => {
    await RAPIER.init();
    const { Vehicle } = (await import('../kits/drive/vehicle.js' as string)) as { Vehicle: new (...a: unknown[]) => { update(dt: number, t: number): void; input: Record<string, unknown>; body: { translation(): { x: number; y: number; z: number }; userForce(): { y: number } }; collider: { handle: number }; health: number; vc: { wheelIsInContact(i: number): boolean } } };
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
    world.timestep = 1 / 60;
    world.createCollider(RAPIER.ColliderDesc.cuboid(5000, 0.5, 5000).setTranslation(0, -0.5, 0).setFriction(1.0));
    const model = { size: { length: 4.45, width: 1.9, height: 1.3, wheelRadius: 0.35, wheelBase: 1.36, track: 0.79 }, group: { position: { set() {} }, quaternion: { set() {} } }, wheels: [], setBraking() {}, update() {} };
    const car = new Vehicle({ scene: { add() {} }, physics: { world, RAPIER } }, model, { mass: 1250 }, { x: 0, z: 0, heading: 0 });
    const events = new RAPIER.EventQueue(true);
    let crashes = 0;
    let maxDown = 0;
    for (let s = 0; s < 60 * 70; s++) {
      // Accelerate 6 s, brake 4 s, again and again (a minute of city driving, straight).
      car.input = { throttle: s % 600 < 360 ? 1 : 0, brake: s % 600 >= 360 ? 1 : 0, steer: 0, handbrake: false, nitro: false };
      car.update(1 / 60, s / 60);
      world.step(events);
      events.drainContactForceEvents((e) => {
        if (e.collider1() === car.collider.handle || e.collider2() === car.collider.handle) crashes++;
      });
      maxDown = Math.max(maxDown, -car.body.userForce().y);
    }
    expect(crashes).toBe(0);
    expect(car.health).toBe(1);
    // Only this step's downforce (about 0.9 × speed², a few thousand newtons at most), never an accumulated pile.
    expect(maxDown).toBeLessThan(10_000);
    expect([0, 1, 2, 3].every((i) => car.vc.wheelIsInContact(i))).toBe(true);
    expect(car.body.translation().y).toBeGreaterThan(-0.2); // on its wheels, not pressed into the road
    expect(Math.abs(car.body.translation().z)).toBeGreaterThan(500); // it really drove
  });
});
