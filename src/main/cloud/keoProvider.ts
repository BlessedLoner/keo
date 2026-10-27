import type { ModelInfo, ProviderStatus } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import { OpenAICompatProvider, type ClientFactory } from '../providers/openaiCompat';
import type { ChatRequest, ChatResult, StreamHandlers } from '../providers/types';
import type { KeoAccount } from './account';

/**
 * Keo's own AI through Keo Cloud: the OpenAI-compatible provider pointed at Keo's gateway, with the
 * user's Keo sign-in instead of an API key. Its models are the ones in the user's plan.
 */
export class KeoCloudProvider extends OpenAICompatProvider {
  constructor(
    getSettings: () => Settings,
    private readonly account: KeoAccount,
    clientFactory?: ClientFactory,
  ) {
    super('keo', getSettings, () => account.token(), clientFactory);
  }

  override models(): ModelInfo[] {
    const m = this.account.models();
    if (!m.length) return super.models();
    return m.map((x) => ({ id: x.id, label: x.label, capabilities: { tools: x.tools, vision: x.vision, streaming: true, contextTokens: x.contextTokens, maxOutputTokens: x.maxOutputTokens } }));
  }

  override status(): ProviderStatus {
    if (!this.account.signedIn()) return { kind: 'unconfigured', reason: 'Sign in to your Keo account (Settings → Providers → Keo account).' };
    return super.status();
  }

  override async stream(req: ChatRequest, handlers: StreamHandlers, signal: AbortSignal): Promise<ChatResult> {
    // The sign-in lasts an hour: renew it first when it is about to end.
    await this.account.fresh();
    try {
      return await super.stream(req, handlers, signal);
    } finally {
      // The plan's usage changed: read it again (in the background).
      this.account.refreshSoon();
    }
  }
}
