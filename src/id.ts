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
