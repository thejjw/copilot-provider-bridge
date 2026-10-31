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

/** Whether a group's apiKey is the sealed pointer for some provider. */
export function isSealedApiKey(apiKey: string): boolean {
  return SEALED_PLACEHOLDER.test(apiKey);
}

/** Provider ids accepted by the helper's protocol. */
export function isSealableProviderId(providerId: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(providerId);
}

const SEALED_PLACEHOLDER = /^\$\{input:chat\.lm\.secret\.cpb-([^}]+)\}$/;
// Greedy id so a dotted custom id (`my.prov`) survives the fixed suffix.
const PLAINTEXT_PLACEHOLDER = /^\$\{input:copilot-provider-bridge\.(.+)\.apiKey\}$/;

function sealedIdFromApiKey(apiKey: string): ProviderId | undefined {
  const sealed = SEALED_PLACEHOLDER.exec(apiKey);
  return sealed?.[1] || undefined;
}

function plaintextIdFromPlaceholder(apiKey: string): ProviderId | undefined {
  const plaintext = PLAINTEXT_PLACEHOLDER.exec(apiKey);
  return plaintext?.[1] || undefined;
}

/** Legacy loose extraction; ambiguous for dotted ids, so it runs last. */
function looseMarkerId(apiKey: string): ProviderId | undefined {
  const markerAt = apiKey.indexOf(EXTENSION_MARKER);
  if (markerAt < 0) return undefined;
  const rest = apiKey.slice(markerAt + EXTENSION_MARKER.length);
  const dot = rest.indexOf('.');
  return dot > 0 ? rest.slice(0, dot) : undefined;
}

/** Parse the provider id out of a bridge-authored apiKey, in either mode. */
export function providerIdFromApiKey(apiKey: string): ProviderId | undefined {
  if (!apiKey) return undefined;
  return sealedIdFromApiKey(apiKey) ?? plaintextIdFromPlaceholder(apiKey) ?? looseMarkerId(apiKey);
}

/**
 * Resolve the provider id for a group, in this order:
 * sealed placeholder, plaintext placeholder, catalog marker (longest id first),
 * loose marker, catalog display name.
 */
export function providerIdForGroup(
  group: GroupIdentity,
  providers: readonly NamedProvider[],
): ProviderId | undefined {
  const sealed = sealedIdFromApiKey(group.apiKey);
  if (sealed) return sealed;

  const exact = plaintextIdFromPlaceholder(group.apiKey);
  if (exact) return exact;

  // A custom `secretInput` may not end in `.apiKey`; match known ids longest-first.
  const byCatalogMarker = [...providers]
    .sort((a, b) => b.id.length - a.id.length)
    .find((p) => group.apiKey.includes(`${EXTENSION_MARKER}${p.id}.`));
  if (byCatalogMarker) return byCatalogMarker.id;

  const loose = looseMarkerId(group.apiKey);
  if (loose) return loose;

  return providers.find((p) => p.name === group.name)?.id;
}
