const stopWords = new Set([
  "about",
  "after",
  "before",
  "does",
  "during",
  "happen",
  "happens",
  "what",
  "when",
  "where",
  "which",
  "with",
]);

function terms(value: string): Set<string> {
  return new Set(
    value
      .toLocaleLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{2,}/gu)
      ?.filter((term) => !stopWords.has(term)) ?? [],
  );
}

export function bestQuestionMatch<T extends { question: string }>(
  question: string,
  candidates: readonly T[],
): T | undefined {
  const query = terms(question);
  if (query.size < 3) return undefined;
  return candidates
    .map((candidate) => {
      const candidateTerms = terms(candidate.question);
      const intersection = [...query].filter((term) =>
        candidateTerms.has(term),
      ).length;
      const containment =
        intersection / Math.min(query.size, candidateTerms.size || 1);
      return { candidate, intersection, containment };
    })
    .filter((match) => match.intersection >= 3 && match.containment >= 0.7)
    .sort(
      (left, right) =>
        right.containment - left.containment ||
        right.intersection - left.intersection,
    )[0]?.candidate;
}
