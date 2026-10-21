// Two ASCII characters per byte value, for a byte's lowercase hex
const HEX_DIGITS = new Uint8Array(512);
for (let byte = 0; byte < 256; byte++) {
  const hex = byte.toString(16).padStart(2, "0");
  HEX_DIGITS[2 * byte] = hex.charCodeAt(0);
  HEX_DIGITS[2 * byte + 1] = hex.charCodeAt(1);
}
const decoder = new TextDecoder();

/**
 * Lowercase hex of `bytes` as one flat string, the same as libauth's `binToHex`. That one appends
 * two characters at a time, which V8 keeps as a chain of pieces: about 1.5 KB of heap for a 32-byte
 * hash instead of about 90 B, for as long as the string lives. For hex that is kept, like a history.
 */
export const toHex = (bytes: Uint8Array): string => {
  const ascii = new Uint8Array(bytes.length * 2);
  for (let i = 0; i < bytes.length; i++) {
    ascii[2 * i] = HEX_DIGITS[2 * bytes[i]];
    ascii[2 * i + 1] = HEX_DIGITS[2 * bytes[i] + 1];
  }
  return decoder.decode(ascii);
};
