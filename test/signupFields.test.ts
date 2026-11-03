import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SignupField, SignupFieldMode } from '../src/contracts/wire.js';
import {
  isNonBlank,
  missingMandatoryFields,
  type SignupFieldValues,
} from '../src/lib/signupFields.js';

/**
 * The sign-up map's one "filled" test (ACCT-U04; P05 fix round 1, BF1 and
 * Opus nice N1). Pure, no DB. A value with no visible character — spaces of
 * any width, NBSP, U+3000, zero-width and other format characters, the
 * blank-rendering fillers — is no value. A value with one visible character is.
 */

const BLANK: Record<string, string> = {
  'two spaces': '  ',
  'a tab': '\t',
  'NBSP only': ' ',
  'U+3000 only': '　',
  'ZWSP only': '​',
  'ZWNJ and ZWJ': '‌‍',
  'word joiner': '⁠',
  'BOM (zero-width no-break space)': '﻿',
  'soft hyphen': '­',
  'Hangul filler': 'ㅤ',
  'braille blank': '⠀',
  'a variation selector': '️',
  'a tag character': '\u{e0020}',
  'mixed blanks': '  ​　⁠\t',
};

const VISIBLE: Record<string, string> = {
  'a plain name': 'Nora Quinlan',
  'an accented name': 'Zoë',
  'a CJK name': '中村',
  'one digit': '0',
  'a hyphen': '-',
  'a name wrapped in blanks': ' ​Nora ',
};

test('isNonBlank: a value with no visible character is blank, whatever its blanks are', () => {
  const wrong = Object.entries(BLANK)
    .filter(([, value]) => isNonBlank(value))
    .map(([label]) => label);
  assert.deepEqual(wrong, [], 'these blanks passed as a value');
  assert.equal(isNonBlank(null), false);
  assert.equal(isNonBlank(''), false);
});

test('isNonBlank: one visible character is a value', () => {
  const wrong = Object.entries(VISIBLE)
    .filter(([, value]) => !isNonBlank(value))
    .map(([label]) => label);
  assert.deepEqual(wrong, [], 'these values read as blank');
});

const MAP: Record<SignupField, SignupFieldMode> = {
  name: 'mandatory',
  phone: 'mandatory',
  email: 'mandatory',
  location: 'mandatory',
  emergency_contact: 'mandatory',
  address: 'asked',
};

const FILLED: SignupFieldValues = {
  name: 'Nora Quinlan',
  phone: '479-555-0150',
  location: 'fayetteville',
  emergencyName: 'Sean Quinlan',
  emergencyPhone: '479-555-0151',
  addressLine1: null,
  addressCity: null,
  addressState: null,
  addressZip: null,
};

test('missingMandatoryFields: a zero-width name or emergency phone is missing (Opus nice N1)', () => {
  assert.deepEqual(missingMandatoryFields(FILLED, MAP), []);
  assert.deepEqual(missingMandatoryFields({ ...FILLED, name: '​' }, MAP), ['name']);
  assert.deepEqual(missingMandatoryFields({ ...FILLED, emergencyPhone: '​' }, MAP), [
    'emergency_contact',
  ]);
});
