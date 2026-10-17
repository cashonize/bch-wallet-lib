import { parseRejection } from "./errors.js";

const fulcrum = (answer: string) =>
  `the transaction was rejected by network rules.\n\n${answer}\n`;

describe("parseRejection", () => {
  test("the reason of BCHN's answer, as Fulcrum wraps it", () => {
    expect(parseRejection(fulcrum("txn-mempool-conflict (code 18)"))).toBe(
      "txn-mempool-conflict",
    );
  });

  test("an answer without a code", () => {
    expect(parseRejection(fulcrum("Missing inputs"))).toBe("Missing inputs");
  });

  test("the reason without the debug message after it", () => {
    expect(
      parseRejection(
        fulcrum(
          "bad-txns-in-belowout, value in (1000) < value out (2000) (code 16)",
        ),
      ),
    ).toBe("bad-txns-in-belowout");
  });

  test("a reason whose own detail holds a comma", () => {
    const reason =
      "mandatory-script-verify-flag-failed (Given operand is not a number within the valid range [-2^31 + 1, 2^31 - 1])";
    expect(parseRejection(fulcrum(`${reason} (code 16)`))).toBe(reason);
  });

  test("ElectrumX's wrapping, with the raw transaction after the answer", () => {
    expect(
      parseRejection(
        "the transaction was rejected by network rules.\n\nnon-final (code 64)\n[0200abcd]",
      ),
    ).toBe("non-final");
  });

  test("a message the server did not wrap", () => {
    expect(parseRejection("Invalid raw transaction hex")).toBe(
      "Invalid raw transaction hex",
    );
  });
});
