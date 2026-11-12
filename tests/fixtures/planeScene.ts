/** A sample visual explanation (how a plane takes off), as a model would write it: used by tests and to try the viewer. */
export const PLANE_SCENE = {
  title: 'How a plane takes off',
  about: 'Thrust builds speed, the wings make lift, and the nose rises.',
  background: 'sky',
  ground: 'floor',
  camera: { from: [-14, 5, 16], to: [0, 1.5, 0] },
  objects: [
    { id: 'runway', shape: 'plane', size: [120, 0.04, 9], at: [20, 0.03, 0], color: '#3b3f46' },
    { id: 'centre-line', shape: 'plane', size: [110, 0.04, 0.25], at: [20, 0.06, 0], color: '#f2f2f2' },
    { id: 'plane', shape: 'capsule', size: [1.6, 9, 1.6], at: [-12, 1.5, 0], rot: [0, 0, 90], color: '#e9edf2', label: 'Fuselage' },
    { id: 'wing-left', shape: 'box', size: [0.25, 2.2, 6], at: [0, 0.3, 3.6], color: '#cfd6de', parent: 'plane', label: 'Wing' },
    { id: 'wing-right', shape: 'box', size: [0.25, 2.2, 6], at: [0, 0.3, -3.6], color: '#cfd6de', parent: 'plane' },
    { id: 'tail', shape: 'box', size: [1.6, 1.4, 0.2], at: [0.9, 3.9, 0], color: '#2f6fed', parent: 'plane', label: 'Tail' },
    { id: 'elevator', shape: 'box', size: [0.15, 1, 3.2], at: [0, 4.2, 0], color: '#2f6fed', parent: 'plane', label: 'Elevator' },
    { id: 'engine-left', shape: 'cylinder', size: [0.9, 1.8, 0.9], at: [-0.7, -0.4, 2.4], color: '#5b6470', parent: 'plane', label: 'Engine' },
    { id: 'engine-right', shape: 'cylinder', size: [0.9, 1.8, 0.9], at: [-0.7, -0.4, -2.4], color: '#5b6470', parent: 'plane' },
    { id: 'thrust', shape: 'arrow', size: [0.3, 1, 1], at: [0, 0, 0], color: '#ff7a1a', glow: true, hidden: true, label: 'Thrust', points: [[-18, 1.5, 0], [-14, 1.5, 0]] },
    { id: 'lift', shape: 'arrow', size: [0.3, 1, 1], at: [0, 0, 0], color: '#35d07f', glow: true, hidden: true, label: 'Lift', parent: 'plane', points: [[-1.2, 0.5, 0], [-4.5, 0.5, 0]] },
    { id: 'air', shape: 'tube', size: [0.12, 1, 1], at: [0, 0, 0], color: '#7fd4ff', glow: true, hidden: true, label: 'Air over the wing', parent: 'plane', points: [[-1.4, -3, 3.6], [-2, -1, 3.6], [-1.6, 1.4, 3.6], [-1.3, 3, 3.6]] },
  ],
  steps: [
    { title: 'Engines push', say: 'The engines throw air backwards. That pushes the plane forwards: this push is called thrust.', seconds: 5, focus: ['engine-left', 'thrust'], moves: [{ id: 'thrust', hidden: false }] },
    { title: 'Speed builds', say: 'The plane rolls faster and faster down the runway. The faster it goes, the more air rushes over the wings.', seconds: 6, focus: ['plane'], camera: { from: [2, 4, 18], to: [8, 1.5, 0] }, moves: [{ id: 'plane', at: [14, 1.5, 0] }, { id: 'thrust', hidden: true }] },
    { title: 'Wings make lift', say: 'Air travels faster over the curved top of the wing than under it. Lower pressure on top pulls the wing upward: lift.', seconds: 6, focus: ['wing-left', 'air', 'lift'], moves: [{ id: 'air', hidden: false }, { id: 'lift', hidden: false }, { id: 'plane', at: [26, 1.5, 0] }] },
    { title: 'Nose up', say: 'The pilot raises the elevator on the tail. The tail is pushed down, the nose tips up, and the wings bite more air.', seconds: 5, focus: ['elevator', 'tail'], moves: [{ id: 'plane', at: [36, 2.4, 0], rot: [0, 0, 78] }, { id: 'air', hidden: true }] },
    { title: 'Airborne', say: 'Lift is now greater than the weight of the plane. It leaves the ground and climbs away.', seconds: 6, focus: ['plane', 'lift'], camera: { from: [30, 6, 24], to: [48, 8, 0] }, moves: [{ id: 'plane', at: [58, 12, 0], rot: [0, 0, 74] }] },
  ],
} as const;
