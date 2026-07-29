export const DEFAULT_MAX_ROUNDS = 3;

export function mayRetry(round: number, maxRounds: number): boolean {
  return round < maxRounds;
}

