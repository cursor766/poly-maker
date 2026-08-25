export interface NormalizedProbabilities {
  probabilities: number[];
  overround: number;
}

export function normalizeDecimalOdds(decimalOdds: readonly number[]): NormalizedProbabilities {
  if (decimalOdds.length < 2) throw new Error("at least two decimal odds are required");
  const implied = decimalOdds.map((odd) => {
    if (!Number.isFinite(odd) || odd <= 1) {
      throw new Error(`invalid decimal odd: ${odd}`);
    }
    return 1 / odd;
  });
  const overround = implied.reduce((sum, probability) => sum + probability, 0);
  if (!Number.isFinite(overround) || overround <= 0) {
    throw new Error("invalid overround");
  }
  return {
    probabilities: implied.map((probability) => probability / overround),
    overround,
  };
}
