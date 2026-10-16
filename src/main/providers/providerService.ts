import type { ProviderId, ProviderInfo } from '../../shared/domain';
import type { Settings } from '../../shared/settings';
import type { Logger } from '../logging/logger';
import type { SecretName, SecretStore } from '../secrets/secretStore';
import { KeoError } from '../util/errors';
import { AnthropicProvider } from './anthropic';
import { OpenAICompatProvider } from './openaiCompat';
import { TestProvider } from './testProvider';
import { ProviderError, type ChatProvider } from './types';

/** Owns provider instances, credential wiring and the active-provider choice. */
export class ProviderService {
  private readonly providers = new Map<ProviderId, ChatProvider>();
  readonly openai: OpenAICompatProvider;

  constructor(
    private readonly getSettings: () => Settings,
    private readonly secrets: SecretStore,
    private readonly log: Logger,
    opts: { testProvider?: TestProvider | null } = {},
  ) {
    const key = (n: SecretName) => () => this.secrets.get(n);
    this.providers.set('anthropic', new AnthropicProvider(getSettings, key('anthropic')));
    this.openai = new OpenAICompatProvider('openai', getSettings, key('openai'));
    this.providers.set('openai', this.openai);
    this.providers.set('openrouter', new OpenAICompatProvider('openrouter', getSettings, key('openrouter')));
    this.providers.set('local', new OpenAICompatProvider('local', getSettings, key('local')));
    if (opts.testProvider) this.providers.set('test', opts.testProvider);
  }

  get(id: ProviderId): ChatProvider {
    const p = this.providers.get(id);
    if (!p) throw new KeoError('provider_unavailable', `Provider ${id} is not available in this build.`);
    return p;
  }

  has(id: ProviderId): boolean {
    return this.providers.has(id);
  }

  /** The provider used for chat, or a clear "unavailable" error. */
  active(): ChatProvider {
    const id = this.getSettings().activeProvider;
    if (!id) throw new ProviderError('unconfigured', 'No model provider is selected. Open Settings → Providers to configure one.');
    const p = this.get(id);
    const st = p.status();
    if (st.kind !== 'ready') throw new ProviderError('unconfigured', st.reason);
    return p;
  }

  list(): ProviderInfo[] {
    return [...this.providers.values()].map((p) => ({
      id: p.id,
      label: p.label,
      description: p.description,
      requiresApiKey: p.requiresApiKey,
      hasApiKey: p.id === 'test' ? false : this.secrets.has(p.id as SecretName),
      destination: p.destination(),
      remote: p.remote,
      models: p.models(),
      selectedModel: p.selectedModel(),
      status: p.status(),
      supportsAudio: p.supportsAudio,
    }));
  }

  setKey(id: ProviderId, apiKey: string): void {
    if (id === 'test') throw new KeoError('invalid_input', 'The test provider takes no key.');
    this.secrets.set(id, apiKey.trim());
    this.log.info('provider.key_set', { providerId: id });
  }

  clearKey(id: ProviderId): void {
    if (id === 'test') return;
    this.secrets.delete(id);
    this.log.info('provider.key_cleared', { providerId: id });
  }
}
