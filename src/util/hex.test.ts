import { binToHex } from "@bitauth/libauth";
import { toHex } from "./hex.js";

test("gives the same hex as binToHex", () => {
  expect(toHex(new Uint8Array())).toBe("");
  const everyByte = Uint8Array.from({ length: 256 }, (_, byte) => byte);
  expect(toHex(everyByte)).toBe(binToHex(everyByte));
  for (const length of [1, 20, 32, 33, 300]) {
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    expect(toHex(bytes)).toBe(binToHex(bytes));
  }
});
