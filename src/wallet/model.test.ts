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
    expect(OpReturnData.from(pushData1(220)).buffer.length).toBe(223);
    expect(() => OpReturnData.from(pushData1(221))).toThrow(
      "OP_RETURN script can not exceed 223 bytes in size",
    );
  });

  test("a 221-byte script, refused before, is built", () => {
    const { buffer } = OpReturnData.from(pushData1(218));
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
    expect(OpReturnData.from(pushData1(75)).buffer.slice(0, 2)).toStrictEqual(
      Uint8Array.from([0x6a, 75]),
    );
    expect(OpReturnData.from(pushData1(76)).buffer.slice(0, 3)).toStrictEqual(
      Uint8Array.from([0x6a, 0x4c, 76]),
    );
  });
});
