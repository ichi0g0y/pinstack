const DEFAULT_ALPHABET = "_-0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function fallbackRandomValues(bytes: Uint8Array): void {
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
}

export function nanoid(size = 21): string {
  const bytes = new Uint8Array(size);
  if (typeof crypto !== "undefined" && "getRandomValues" in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    fallbackRandomValues(bytes);
  }

  let id = "";
  for (let i = 0; i < bytes.length; i += 1) {
    id += DEFAULT_ALPHABET[bytes[i] % DEFAULT_ALPHABET.length];
  }

  return id;
}

function fnv1a32(input: string, seed = 2166136261): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function hashPinnedItemId(groupId: string, url: string): string {
  const payload = `${groupId}|${url}`;
  const partA = fnv1a32(payload).toString(16).padStart(8, "0");
  const partB = fnv1a32(payload, 2166136261 ^ 0x01000193).toString(16).padStart(8, "0");
  return `p-${partA}${partB}`;
}
