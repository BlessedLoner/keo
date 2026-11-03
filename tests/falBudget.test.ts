import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeHarness, passthroughImages } from './helpers';

describe('fal.ai spending and the monthly limit', () => {
  it('adds up what Keo recorded, and refuses a request over the limit before sending anything', async () => {
    const sent: string[] = [];
    const h = makeHarness({
      deps: {
        imageTools: { ...passthroughImages, jpeg: () => Buffer.from('jpeg') },
        aiVideoFetch: async (url) => {
          sent.push(url);
          return { ok: false, status: 500, json: async () => ({}), arrayBuffer: async () => new ArrayBuffer(0) };
        },
      },
    });
    try {
      h.services.audit.record({ kind: 'studio.ai_shot', decision: 'sent', detail: { destination: 'fal.ai', costUsd: 0.56 } });
      h.services.audit.record({ kind: 'studio.character_swap', decision: 'sent', detail: { destination: 'fal.ai', costUsd: 0.42 } });
      // Not fal.ai money: left out.
      h.services.audit.record({ kind: 'studio.faceless', decision: 'sent', detail: { costUsd: 9 } });
      expect(h.services.falSpending()).toEqual({ todayUsd: 0.98, monthUsd: 0.98, limitUsd: null });
      h.services.settings.update({ aiVideo: { monthlyLimitUsd: 1 } });
      h.services.secrets.set('fal', 'fal-test-key-123');
      const kira = h.services.studio.saveCharacter({ name: 'Kira' });
      const photo = path.join(h.dir, 'kira.png');
      fs.writeFileSync(photo, 'png');
      h.services.studio.addCharacterPicture(kira.id, photo);
      // $0.98 spent + about $0.04 > $1: refused, and nothing reached fal.ai.
      await expect(h.services.characterMorePose(kira.id, 'on a beach', new AbortController().signal)).rejects.toThrow(/monthly fal.ai limit/);
      expect(sent).toEqual([]);
    } finally {
      await h.close();
    }
  });
});
