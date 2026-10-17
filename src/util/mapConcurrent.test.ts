import { Limiter, mapConcurrent } from "./mapConcurrent.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

test("keeps the input order with at most `concurrency` calls running", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 25 }, (_, i) => i);
  const results = await mapConcurrent(items, 4, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    // later items finish first, so the order is not the completion order
    for (let i = 0; i < 25 - item; i++) await tick();
    inFlight--;
    return item * 2;
  });
  expect(results).toEqual(items.map((item) => item * 2));
  expect(maxInFlight).toBe(4);
});

test("rejects with the first error and starts no call after it", async () => {
  const started: number[] = [];
  const result = mapConcurrent([0, 1, 2, 3, 4, 5], 2, async (item) => {
    started.push(item);
    await tick();
    if (item === 1) throw new Error("boom 1");
    return item;
  });
  await expect(result).rejects.toThrow("boom 1");
  await tick();
  await tick();
  // 0 and 1 start together, 2 replaces 0 before 1 fails
  expect(started).toEqual([0, 1, 2]);
});

test("Infinity starts every call at once", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const items = Array.from({ length: 25 }, (_, i) => i);
  const results = await mapConcurrent(items, Infinity, async (item) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await tick();
    inFlight--;
    return item;
  });
  expect(results).toEqual(items);
  expect(maxInFlight).toBe(25);
});

test("refuses a concurrency below 1 or not an integer", async () => {
  await expect(mapConcurrent([1], 0, async (x) => x)).rejects.toThrow(
    RangeError,
  );
  await expect(mapConcurrent([1], 1.5, async (x) => x)).rejects.toThrow(
    RangeError,
  );
  await expect(mapConcurrent([1], NaN, async (x) => x)).rejects.toThrow(
    RangeError,
  );
  await expect(mapConcurrent([1], -Infinity, async (x) => x)).rejects.toThrow(
    RangeError,
  );
  expect(await mapConcurrent([], 3, async (x) => x)).toEqual([]);
});

test("fan-outs sharing a Limiter keep to its bound together", async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fn = async (item: number) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    for (let i = 0; i < 1 + (item % 3); i++) await tick();
    inFlight--;
    return item;
  };
  const items = Array.from({ length: 10 }, (_, i) => i);
  const limiter = new Limiter(3);
  const [a, b] = await Promise.all([
    mapConcurrent(items, limiter, fn),
    mapConcurrent(items, limiter, fn),
  ]);
  expect(a).toEqual(items);
  expect(b).toEqual(items);
  expect(maxInFlight).toBe(3);
  expect(() => new Limiter(0)).toThrow(RangeError);
});
