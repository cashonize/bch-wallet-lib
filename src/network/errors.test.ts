import { parseRejection } from "./errors.js";

const fulcrum = (answer: string) =>
  `the transaction was rejected by network rules.\n\n${answer}\n`;

describe("parseRejection", () => {
  test("the reason and code of BCHN's answer, as Fulcrum wraps it", () => {
    expect(parseRejection(fulcrum("txn-mempool-conflict (code 18)"))).toEqual({
      reason: "txn-mempool-conflict",
      code: 18,
    });
  });

  test("an answer without a code", () => {
    expect(parseRejection(fulcrum("Missing inputs"))).toEqual({
      reason: "Missing inputs",
      code: undefined,
    });
  });

  test("the reason without the debug message after it", () => {
    expect(
      parseRejection(
        fulcrum(
          "bad-txns-in-belowout, value in (1000) < value out (2000) (code 16)",
        ),
      ),
    ).toEqual({ reason: "bad-txns-in-belowout", code: 16 });
  });

  test("a reason whose own detail holds a comma", () => {
    const reason =
      "mandatory-script-verify-flag-failed (Given operand is not a number within the valid range [-2^31 + 1, 2^31 - 1])";
    expect(parseRejection(fulcrum(`${reason} (code 16)`))).toEqual({
      reason,
      code: 16,
    });
  });

  test("ElectrumX's wrapping, with the raw transaction after the answer", () => {
    expect(
      parseRejection(
        "the transaction was rejected by network rules.\n\nnon-final (code 64)\n[0200abcd]",
      ),
    ).toEqual({ reason: "non-final", code: 64 });
  });

  test("a message the server did not wrap", () => {
    expect(parseRejection("Invalid raw transaction hex")).toEqual({
      reason: "Invalid raw transaction hex",
      code: undefined,
    });
  });
});
