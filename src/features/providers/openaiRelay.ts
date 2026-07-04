import type { Config, OpenAIProviderConfig } from '@/types';

export const OPENAI_RELAY_PROVIDER_NAME = 'openaiRelay';
export const OPENAI_RELAY_DISPLAY_NAME = 'OpenAI 中转';
export const OPENAI_RELAY_HOMEPAGE_URL = 'https://www.inroi.shop';
export const OPENAI_RELAY_BASE_URL = OPENAI_RELAY_HOMEPAGE_URL;
export const OPENAI_RELAY_OPENAI_BASE_URL = `${OPENAI_RELAY_BASE_URL}/v1`;

const normalizeText = (value: string | undefined | null): string =>
  String(value ?? '')
    .trim()
    .toLowerCase();

const normalizeBaseUrl = (value: string | undefined | null): string =>
  normalizeText(value).replace(/\/+$/, '');

export const isOpenaiRelayProvider = (
  config: OpenAIProviderConfig | undefined | null
): boolean => {
  if (!config) return false;
  return (
    normalizeText(config.name) === normalizeText(OPENAI_RELAY_PROVIDER_NAME) ||
    normalizeBaseUrl(config.baseUrl) === normalizeBaseUrl(OPENAI_RELAY_BASE_URL) ||
    normalizeBaseUrl(config.baseUrl) === normalizeBaseUrl(OPENAI_RELAY_OPENAI_BASE_URL)
  );
};

export const buildOpenaiRelayRaw = (
  config: Config | null | undefined
): Array<{ config: OpenAIProviderConfig; index: number }> =>
  (config?.openaiCompatibility ?? [])
    .map((item, index) => ({ config: item, index }))
    .filter((item) => isOpenaiRelayProvider(item.config));

export const hasOpenaiRelayConfig = (config: Config | null | undefined): boolean =>
  buildOpenaiRelayRaw(config).length > 0;