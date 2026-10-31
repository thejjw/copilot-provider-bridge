// Pure recognition of provider groups written by this extension.
//
// A bridge group is identified in one of two modes:
//   plaintext: apiKey holds ${input:copilot-provider-bridge.<id>.apiKey}
//   sealed:    apiKey holds ${input:chat.lm.secret.cpb-<id>}
// Plaintext groups written with a literal key fall back to the catalog display
// name, because core's "Update API Key" drops unknown fields and rewrites the
// apiKey value. Keep this module free of `vscode` so unit tests can import it
// and every consumer shares one match order.

import { EXTENSION_MARKER, type ProviderId } from './providers';

/** Prefix of the stable core-vault secret id owned by this extension. */
export const SEALED_SECRET_PREFIX = 'chat.lm.secret.cpb-';

export interface GroupIdentity {
  name: string;
  apiKey: string;
}

/** Minimal catalog shape needed for the display-name fallback. */
export interface NamedProvider {
  id: ProviderId;
  name: string;
}

/** Stable secret id for a provider's sealed key, e.g. `chat.lm.secret.cpb-zai`. */
export function sealedSecretId(providerId: ProviderId): string {
  return `${SEALED_SECRET_PREFIX}${providerId}`;
}

/** Value written to a sealed group's `apiKey`, e.g. `${input:chat.lm.secret.cpb-zai}`. */
export function sealedApiKeyPlaceholder(providerId: ProviderId): string {
  return `\${input:${sealedSecretId(providerId)}}`;
}

/** Parse the provider id out of a bridge-authored apiKey, in either mode. */
export function providerIdFromApiKey(apiKey: string): ProviderId | undefined {
  if (!apiKey) return undefined;

  const sealed = /^\$\{input:chat\.lm\.secret\.cpb-([^}]+)\}$/.exec(apiKey);
  if (sealed && sealed[1]) return sealed[1];

  const markerAt = apiKey.indexOf(EXTENSION_MARKER);
  if (markerAt >= 0) {
    const rest = apiKey.slice(markerAt + EXTENSION_MARKER.length);
    const dot = rest.indexOf('.');
    if (dot > 0) return rest.slice(0, dot);
  }

  return undefined;
}

/**
 * Resolve the provider id for a group, in this order:
 * plaintext marker, sealed placeholder, catalog display name.
 */
export function providerIdForGroup(
  group: GroupIdentity,
  providers: readonly NamedProvider[],
): ProviderId | undefined {
  const fromKey = providerIdFromApiKey(group.apiKey);
  if (fromKey) return fromKey;
  return providers.find((p) => p.name === group.name)?.id;
}
