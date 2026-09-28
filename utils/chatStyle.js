const QUALIFYING_TERM_PATTERNS = [
  /^fuck(?:s|ed|ing|er|ers)?$/,
  /^shit(?:s|ty|ted|ting|head|heads)?$/,
  /^damn(?:ed|ing)?$/,
  /^hell$/,
  /^asshole(?:s)?$/,
  /^bastard(?:s)?$/,
  /^bitch(?:es|y|ing)?$/,
  /^dickhead(?:s)?$/,
  /^dipshit(?:s)?$/,
  /^prick(?:s)?$/,
  /^wanker(?:s)?$/,
  /^cunt(?:s)?$/,
  /^twat(?:s)?$/,
  /^whore(?:s)?$/,
  /^slut(?:s|ty)?$/,
  /^pervert(?:s|ed)?$/,
  /^degenerate(?:s|d)?$/,
  /^jackass(?:es)?$/,
  /^dumbass(?:es)?$/,
  /^motherfuck(?:er|ers|ing)?$/,
];

function tokenize(text) {
  if (typeof text !== 'string') return [];
  return text.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) || [];
}

function countWords(text) {
  return tokenize(text).length;
}

function countQualifyingTerms(text) {
  return tokenize(text).filter((word) =>
    QUALIFYING_TERM_PATTERNS.some((pattern) => pattern.test(word))
  ).length;
}

function evaluateProfanityDensity(text) {
  const wordCount = countWords(text);
  const qualifyingCount = countQualifyingTerms(text);
  const requiredCount = wordCount === 0 ? 0 : Math.max(1, Math.ceil(wordCount / 6));

  return {
    wordCount,
    qualifyingCount,
    requiredCount,
    passes: qualifyingCount >= requiredCount,
  };
}

function buildStyleRewriteInput(draft, evaluation = evaluateProfanityDensity(draft)) {
  return [
    'Rewrite the draft below in Tsun\'s voice.',
    `It currently has ${evaluation.qualifyingCount} qualifying curse/insult terms and needs at least ${evaluation.requiredCount}.`,
    'Preserve all facts, answers, boundaries, and useful instructions.',
    'Keep it concise and natural; increase profanity density without adding protected-class slurs.',
    '',
    'DRAFT',
    draft,
  ].join('\n');
}

function chooseDenserDraft(first, second) {
  const firstEvaluation = evaluateProfanityDensity(first);
  const secondEvaluation = evaluateProfanityDensity(second);
  const firstDensity = firstEvaluation.qualifyingCount / Math.max(1, firstEvaluation.wordCount);
  const secondDensity = secondEvaluation.qualifyingCount / Math.max(1, secondEvaluation.wordCount);
  return secondDensity > firstDensity ? second : first;
}

module.exports = {
  countWords,
  countQualifyingTerms,
  evaluateProfanityDensity,
  buildStyleRewriteInput,
  chooseDenserDraft,
};
