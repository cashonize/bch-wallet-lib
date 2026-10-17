import { binToHex, binToUtf8, hexToBin } from "@bitauth/libauth";
import { UtxoId } from "../interface.js";
import { fromUtxoId, OpReturnData, toUtxoId } from "./model.js";

test("Should serialize utxo", () => {
  const utxo = toUtxoId({
    txid: "this",
    vout: 42,
  }).toString();
  expect(utxo).toBe("this:42");
});

test("Should deserialize utxo", () => {
  const utxo = fromUtxoId("this:42:1");
  expect(utxo.txid).toBe("this");
  expect(utxo.vout).toBe(42);
});

test("Should deserialize utxo", () => {
  const u = {
    txid: "this",
    vout: 42,
  } as UtxoId;
  expect(toUtxoId(u)).toBe("this:42");
});

describe("OpReturnData limits", () => {
  // OP_RETURN, OP_PUSHDATA1 <length>, data: a script 3 bytes longer than its data
  const pushData1 = (length: number) => new Uint8Array(length).fill(0xab);

  test("a 223-byte script is built, a 224-byte one refused", () => {
    expect(OpReturnData.fromArray([pushData1(220)]).buffer.length).toBe(223);
    expect(() => OpReturnData.fromArray([pushData1(221)])).toThrow(
      "OP_RETURN script can not exceed 223 bytes in size",
    );
  });

  test("a 221-byte script, refused before, is built", () => {
    const { buffer } = OpReturnData.fromArray([pushData1(218)]);
    expect(buffer.length).toBe(221);
    expect(buffer.slice(0, 3)).toStrictEqual(
      Uint8Array.from([0x6a, 0x4c, 218]),
    );
  });

  test("the limit counts the whole script over several pushes", () => {
    // 1 + (1 + 4) + (2 + 215) = 223
    const fits = OpReturnData.fromArray(["BCMR", pushData1(215)]);
    expect(fits.buffer.length).toBe(223);
    expect(() => OpReturnData.fromArray(["BCMR", pushData1(216)])).toThrow(
      "OP_RETURN script can not exceed 223 bytes",
    );
  });

  test("pushes switch to OP_PUSHDATA1 at 76 bytes", () => {
    expect(
      OpReturnData.fromArray([pushData1(75)]).buffer.slice(0, 2),
    ).toStrictEqual(Uint8Array.from([0x6a, 75]));
    expect(
      OpReturnData.fromArray([pushData1(76)]).buffer.slice(0, 3),
    ).toStrictEqual(Uint8Array.from([0x6a, 0x4c, 76]));
  });
});

describe("OpReturnData.parseBinary", () => {
  test("goes on past an empty push", () => {
    const chunks = OpReturnData.parseBinary(
      hexToBin("6a0442434d52000b61667465722d656d707479"),
    );
    expect(chunks.map((chunk) => binToUtf8(chunk))).toStrictEqual([
      "BCMR",
      "",
      "after-empty",
    ]);
  });

  test("reads OP_1NEGATE and OP_1..OP_16 as their numbers", () => {
    const chunks = OpReturnData.parseBinary(
      hexToBin("6a044142434451604f03aabbcc"),
    );
    expect(chunks.map((chunk) => binToHex(chunk))).toStrictEqual([
      "41424344",
      "01",
      "10",
      "81",
      "aabbcc",
    ]);
  });

  test("reads OP_PUSHDATA1 and OP_PUSHDATA2", () => {
    const chunks = OpReturnData.parseBinary(hexToBin("6a4c02aabb4d0300ccddee"));
    expect(chunks.map((chunk) => binToHex(chunk))).toStrictEqual([
      "aabb",
      "ccddee",
    ]);
  });

  test("round-trips what fromArray builds", () => {
    const parts = ["BCMR", "", "x".repeat(80), "after"];
    const { buffer } = OpReturnData.fromArray(parts);
    expect(
      OpReturnData.parseBinary(buffer).map((chunk) => binToUtf8(chunk)),
    ).toStrictEqual(parts);
  });

  test("a bare OP_RETURN has no chunks", () => {
    expect(OpReturnData.parseBinary(Uint8Array.from([0x6a]))).toStrictEqual([]);
  });

  test("throws on a non-push opcode, a truncated push, or a script that is no OP_RETURN", () => {
    // OP_DUP after a push
    expect(() => OpReturnData.parseBinary(hexToBin("6a0141" + "76"))).toThrow(
      "Non-push opcode 0x76 in OP_RETURN script",
    );
    // pushes 4 bytes, only 2 follow
    expect(() => OpReturnData.parseBinary(hexToBin("6a04aabb"))).toThrow(
      "Malformed push in OP_RETURN script",
    );
    expect(() => OpReturnData.parseBinary(hexToBin("0141"))).toThrow(
      "Not an OP_RETURN script",
    );
  });
});
