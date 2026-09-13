import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  guidanceText,
  parseRules,
  ruleFlagSet,
  ruleMap,
  ruleNumber,
  ruleSceneFilter,
  ruleValue,
} from '../src/rules/parseRules';

test('directives are parsed and free text is kept as guidance', () => {
  const rules = parseRules(
    [
      '# how to break this down',
      'panel per: beat',
      'shot for line: MCU',
      'keep the jokes on the same panel as the reaction',
      'note: pacing should feel unhurried',
      '',
    ].join('\n'),
  );

  assert.equal(ruleValue(rules, 'panel per'), 'beat');
  assert.equal(ruleValue(rules, 'shot for line'), 'MCU');
  assert.deepEqual(rules.guidance, [
    'keep the jokes on the same panel as the reaction',
    'note: pacing should feel unhurried',
  ]);
  assert.equal(rules.unknown.length, 1, 'unknown key is flagged, not dropped');
  assert.equal(rules.unknown[0]?.key, 'note');
});

test('keys are case and space insensitive, last value wins', () => {
  const rules = parseRules('Shot   For   Line: WS\nshot for line: CU');
  assert.equal(ruleValue(rules, 'shot for line'), 'CU');
});

test('comments are stripped but hashes inside values survive', () => {
  const rules = parseRules('carry: sound -> notes # only the cue\ncolor: #ff8800');
  assert.equal(ruleValue(rules, 'carry'), 'sound -> notes');
  // `#ff8800` is only reachable if the comment stripper needs whitespace.
  assert.equal(ruleValue(rules, 'color'), '#ff8800');
});

test('numbers, flag sets and maps', () => {
  const rules = parseRules('min duration: 1.5\nignore: direction, Sound\ncarry: sound -> notes\ncarry: dialog');
  assert.equal(ruleNumber(rules, 'min duration', 9), 1.5);
  assert.equal(ruleNumber(rules, 'max duration', 9), 9);
  assert.deepEqual([...ruleFlagSet(rules, 'ignore')].sort(), ['direction', 'sound']);
  assert.deepEqual(ruleMap(rules, 'carry'), { sound: 'notes', dialog: 'dialog' });
});

test('scene filters accept ranges, lists and all', () => {
  assert.equal(ruleSceneFilter(parseRules('scenes: 2-4'))(3), true);
  assert.equal(ruleSceneFilter(parseRules('scenes: 2-4'))(5), false);
  assert.equal(ruleSceneFilter(parseRules('scenes: 1,4'))(4), true);
  assert.equal(ruleSceneFilter(parseRules('scenes: 1,4'))(2), false);
  assert.equal(ruleSceneFilter(parseRules('scenes: all'))(9), true);
  assert.equal(ruleSceneFilter(parseRules(''))(9), true);
});

test('guidance text includes keep/never/always directives verbatim', () => {
  const rules = parseRules('panel per: beat\nnever: invent new characters\nhold on the reaction');
  const text = guidanceText(rules);
  assert.match(text, /hold on the reaction/);
  assert.match(text, /never: invent new characters/);
  assert.doesNotMatch(text, /panel per/);
});
