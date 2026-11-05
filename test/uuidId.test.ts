import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { uuidId } from '../src/lib/uuidId.js';

const LOWER = '1f0e2d3c-4b5a-4687-a9b8-c7d6e5f4a3b2';
const UPPER = LOWER.toUpperCase();

test('uuidId lowercases a capitalised id and leaves a lowercase one as it is', () => {
  assert.notEqual(UPPER, LOWER);
  assert.equal(uuidId().parse(UPPER), LOWER);
  assert.equal(uuidId().parse(LOWER), LOWER);
  assert.equal(uuidId().parse('1F0E2d3c-4B5a-4687-A9b8-c7D6E5f4a3B2'), LOWER);
});

test('uuidId refuses what is not a uuid, in the route words or in zod words', () => {
  const issue = (schema: z.ZodType<string>): string | undefined => {
    const parsed = schema.safeParse('not-a-uuid');
    assert.equal(parsed.success, false);
    return parsed.error?.issues[0]?.message;
  };
  assert.equal(issue(uuidId()), issue(z.string().uuid()));
  assert.equal(issue(uuidId('dog_id must be a UUID')), 'dog_id must be a UUID');
  assert.equal(uuidId().safeParse(undefined).success, false);
  assert.equal(uuidId().safeParse(7).success, false);
});

test('uuidId keeps lowercasing wherever the routes wrap it', () => {
  const body = z.object({
    array: z.array(uuidId()),
    optional: uuidId().optional(),
    nullable: uuidId().nullable(),
  });
  assert.deepEqual(body.parse({ array: [UPPER], optional: UPPER, nullable: UPPER }), {
    array: [LOWER],
    optional: LOWER,
    nullable: LOWER,
  });
  assert.deepEqual(body.parse({ array: [], nullable: null }), { array: [], nullable: null });
});
