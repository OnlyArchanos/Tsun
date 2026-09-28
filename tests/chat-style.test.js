const test = require('node:test');
const assert = require('node:assert/strict');

const {
  countWords,
  countQualifyingTerms,
  evaluateProfanityDensity,
  buildStyleRewriteInput,
  chooseDenserDraft,
} = require('../utils/chatStyle');

test('counts words and approved profanity through punctuation and inflections', () => {
  assert.equal(countWords("Well, that's fucking ridiculous as hell."), 6);
  assert.equal(countQualifyingTerms("FUCK, fucked, fucking; harmless."), 3);
  assert.equal(countQualifyingTerms('retard queer racial-slur'), 0);
});

test('requires at least one qualifying term per six words including short replies', () => {
  assert.deepEqual(evaluateProfanityDensity('Fine, asshole.'), {
    wordCount: 2,
    qualifyingCount: 1,
    requiredCount: 1,
    passes: true,
  });
  const evaluation = evaluateProfanityDensity('one two three four five six seven eight nine ten eleven twelve');
  assert.equal(evaluation.requiredCount, 2);
  assert.equal(evaluation.passes, false);
});

test('rewrite input states the exact deficit and preserves the original draft', () => {
  const input = buildStyleRewriteInput('A useful factual answer with no profanity.', {
    wordCount: 7,
    qualifyingCount: 0,
    requiredCount: 2,
    passes: false,
  });

  assert.match(input, /at least 2/i);
  assert.match(input, /currently has 0/i);
  assert.match(input, /A useful factual answer/);
  assert.match(input, /preserve.*facts/i);
});

test('chooses the draft with greater profanity density without modifying either', () => {
  const clean = 'That answer is completely clear and useful.';
  const profane = 'That damn answer is fucking clear and useful.';
  assert.equal(chooseDenserDraft(clean, profane), profane);
  assert.equal(chooseDenserDraft(profane, clean), profane);
});
