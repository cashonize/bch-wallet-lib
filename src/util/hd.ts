export const arrayRange = (start: number, stop: number) =>
  Array.from({ length: stop - start }, (_, index) => start + index);

export const getNextUnusedIndex = (
  index: number,
  statuses: Array<string | null>,
): number => {
  if (index === -1) {
    index = statuses.findIndex((status) => status === null);
    if (index === -1) {
      index = statuses.length;
    }
  }

  return index;
};

// the first `count` unused indices, in order; indices past the known
// statuses count as unused
export const getNextUnusedIndices = (
  count: number,
  statuses: Array<string | null>,
): number[] => {
  const indices: number[] = [];
  for (let index = 0; indices.length < count; index++) {
    if (index >= statuses.length || statuses[index] === null) {
      indices.push(index);
    }
  }
  return indices;
};
