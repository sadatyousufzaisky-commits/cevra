export interface ProviderModel {
  readonly id: string;
  readonly label: string;
  readonly maxInputBytes: number;
  readonly maxOutputTokens: number;
  readonly streaming: true;
  readonly toolProposals: false;
}

export interface ProviderCatalog {
  readonly abiVersion: '0.1';
  readonly providerId: string;
  readonly label: string;
  readonly provenance: string;
  readonly models: readonly ProviderModel[];
}

export interface ProviderRequest {
  readonly abiVersion: '0.1';
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly messages: readonly Readonly<{ role: 'system' | 'user' | 'assistant'; content: string }>[];
  readonly maxOutputTokens: number;
}

export type ReportedErrorCode = 'PROVIDER_UNAVAILABLE' | 'AUTH_INVALID' | 'AUTH_EXPIRED' |
  'QUOTA_EXHAUSTED' | 'RATE_LIMIT' | 'NETWORK_BLOCKED';

export type ProviderEvent = Readonly<{ requestId: string } & (
  | { kind: 'text.delta'; text: string }
  | { kind: 'usage'; inputTokens: number; outputTokens: number }
  | { kind: 'error'; code: ReportedErrorCode; retryable: boolean }
  | { kind: 'complete'; finishReason: 'stop' | 'length' }
)>;

export interface ProviderAdapter {
  readonly catalog: ProviderCatalog;
  stream(request: ProviderRequest, signal: AbortSignal): AsyncIterable<ProviderEvent>;
}

export function createProviderRegistry(adapters: readonly ProviderAdapter[]): Readonly<{
  list(): readonly ProviderCatalog[];
  stream(request: ProviderRequest, options?: Readonly<{ signal?: AbortSignal; deadlineMs?: number }>): AsyncGenerator<ProviderEvent, void>;
}>;
