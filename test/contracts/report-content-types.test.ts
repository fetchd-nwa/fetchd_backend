import assert from 'node:assert/strict';
import { test } from 'node:test';
import { registerReportsRoute } from '../../src/routes/reports.js';
import { FIXTURE_IDS } from './_fixture.js';
import {
  FIXTURE_OWNER_PRINCIPAL,
  SKIP_WHEN_NO_DB,
  makeContractApp,
  registerFixtureHooks,
} from './_harness.js';

/**
 * Runtime pins for the wire 1.13.0 §14.2-A narrowing: `ReportWire`'s four
 * `*_content` blobs stopped being `unknown` and became
 * `PrivateLessonContentWire`, `BoardingSessionContentWire`,
 * `BoardTrainSessionContentWire` and `GroupClassSessionContentWire`.
 *
 * `reports.test.ts` already byte-matches these emissions against snapshots.
 * This file asserts something the snapshots cannot: that the emission's KEY
 * SET is exactly what the wire type declares — every required key present and
 * correctly typed, every present optional key correctly typed, and NO key the
 * type does not know about. An unexpected key means the promoted type is
 * incomplete, which is the drift this pin exists to catch.
 */

registerFixtureHooks();

type KeySpec = { required: Record<string, string>; optional: Record<string, string> };

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

/** Assert one object against a key spec, then recurse via `children`. */
function assertShape(
  where: string,
  value: unknown,
  spec: KeySpec,
  children: (v: Record<string, unknown>) => void = () => {},
): void {
  assert.equal(typeOf(value), 'object', `${where}: expected an object`);
  const obj = value as Record<string, unknown>;

  for (const [key, want] of Object.entries(spec.required)) {
    assert.ok(key in obj, `${where}: missing required key '${key}'`);
    assert.equal(typeOf(obj[key]), want, `${where}.${key}: wrong type`);
  }
  for (const [key, want] of Object.entries(spec.optional)) {
    if (!(key in obj)) continue;
    assert.equal(typeOf(obj[key]), want, `${where}.${key}: wrong type`);
  }
  const known = new Set([...Object.keys(spec.required), ...Object.keys(spec.optional)]);
  for (const key of Object.keys(obj)) {
    assert.ok(known.has(key), `${where}: key '${key}' is not in the wire type`);
  }
  children(obj);
}

function assertStringArray(where: string, value: unknown): void {
  assert.ok(Array.isArray(value), `${where}: expected an array`);
  for (const [i, item] of value.entries()) {
    assert.equal(typeof item, 'string', `${where}[${i}]: expected a string`);
  }
}

// ---- the four wire types, as runtime key specs ---------------------------

const SECTION_KINDS = new Set(['steps', 'list', 'note', 'videos']);

/** PrivateLessonSectionWire — a discriminated union, so it is checked per arm. */
function assertPrivateLessonSection(where: string, value: unknown): void {
  assert.equal(typeOf(value), 'object', `${where}: expected an object`);
  const section = value as Record<string, unknown>;
  const kind = section['kind'];
  assert.ok(
    typeof kind === 'string' && SECTION_KINDS.has(kind),
    `${where}.kind: '${String(kind)}' is not a PrivateLessonSectionWire arm`,
  );
  if (kind === 'note') {
    assertShape(`${where}(note)`, section, {
      required: { kind: 'string', text: 'string' },
      optional: {},
    });
    return;
  }
  if (kind === 'videos') {
    assertShape(
      `${where}(videos)`,
      section,
      { required: { kind: 'string', items: 'array' }, optional: { label: 'string' } },
      (s) => {
        for (const [i, item] of (s['items'] as unknown[]).entries()) {
          assertShape(`${where}(videos).items[${i}]`, item, {
            required: { title: 'string' },
            optional: { subtitle: 'string' },
          });
        }
      },
    );
    return;
  }
  // 'steps' | 'list'
  assertShape(
    `${where}(${kind})`,
    section,
    { required: { kind: 'string', items: 'array' }, optional: { label: 'string' } },
    (s) => assertStringArray(`${where}(${kind}).items`, s['items']),
  );
}

function assertPrivateLessonContent(where: string, value: unknown): void {
  assertShape(
    where,
    value,
    { required: { session_focus: 'string', topics: 'array' }, optional: {} },
    (content) => {
      for (const [i, topic] of (content['topics'] as unknown[]).entries()) {
        assertShape(
          `${where}.topics[${i}]`,
          topic,
          { required: { id: 'string', title: 'string', sections: 'array' }, optional: {} },
          (t) => {
            for (const [j, section] of (t['sections'] as unknown[]).entries()) {
              assertPrivateLessonSection(`${where}.topics[${i}].sections[${j}]`, section);
            }
          },
        );
      }
    },
  );
}

/** BoardingSessionContentWire — and, by alias, BoardTrainSessionContentWire. */
function assertStayContent(where: string, value: unknown): void {
  assertShape(
    where,
    value,
    {
      required: {
        check_in_date: 'string',
        check_out_date: 'string',
        nights: 'number',
        days: 'array',
      },
      optional: { summary: 'string' },
    },
    (content) => {
      for (const [i, day] of (content['days'] as unknown[]).entries()) {
        assertShape(
          `${where}.days[${i}]`,
          day,
          {
            required: { date: 'string', label: 'string', activities: 'array' },
            optional: {
              sleep_note: 'string',
              meals_note: 'string',
              trainer_note: 'string',
              photo_count: 'number',
            },
          },
          (d) => assertStringArray(`${where}.days[${i}].activities`, d['activities']),
        );
      }
    },
  );
}

function assertGroupClassContent(where: string, value: unknown): void {
  assertShape(
    where,
    value,
    {
      required: { class_name: 'string', week_count: 'number', weeks: 'array' },
      optional: { cohort_label: 'string' },
    },
    (content) => {
      for (const [i, week] of (content['weeks'] as unknown[]).entries()) {
        assertShape(
          `${where}.weeks[${i}]`,
          week,
          {
            required: { week_number: 'number', date: 'string', title: 'string', topics: 'array' },
            optional: {
              location: 'string',
              intro: 'string',
              highlight: 'string',
              practice_items: 'array',
              concepts: 'array',
              closing_note: 'string',
            },
          },
          (w) => {
            if ('practice_items' in w) {
              assertStringArray(`${where}.weeks[${i}].practice_items`, w['practice_items']);
            }
            if ('concepts' in w) {
              assertStringArray(`${where}.weeks[${i}].concepts`, w['concepts']);
            }
            for (const [j, topic] of (w['topics'] as unknown[]).entries()) {
              // `isLinked` is camelCase on purpose — it is the emitted key and
              // the one mobile's renderer reads. Renaming it is a behavior
              // change (wire-contract-completion §14.1); this pin is what makes
              // an accidental rename fail loudly.
              assertShape(`${where}.weeks[${i}].topics[${j}]`, topic, {
                required: { label: 'string' },
                optional: { description: 'string', isLinked: 'boolean' },
              });
            }
          },
        );
      }
    },
  );
}

// ---- the pins ------------------------------------------------------------

async function fetchReport(id: string): Promise<Record<string, unknown>> {
  const { app, authenticate } = makeContractApp(FIXTURE_OWNER_PRINCIPAL);
  registerReportsRoute(app, { authenticate });
  const res = await app.inject({ method: 'GET', url: `/reports/${id}` });
  if (res.statusCode !== 200) {
    throw new Error(`/reports/${id} returned ${res.statusCode}: ${res.body}`);
  }
  return res.json() as Record<string, unknown>;
}

test(
  'private_lesson_content parses as PrivateLessonContentWire (§14.2-A runtime pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    const body = await fetchReport(FIXTURE_IDS.reportPrivateLessonId);
    assert.equal(body['program'], 'private-lesson');
    assertPrivateLessonContent('private_lesson_content', body['private_lesson_content']);
  },
);

test(
  'boarding_session_content parses as BoardingSessionContentWire (§14.2-A runtime pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    const body = await fetchReport(FIXTURE_IDS.reportBoardingId);
    assert.equal(body['program'], 'boarding-session');
    assertStayContent('boarding_session_content', body['boarding_session_content']);
  },
);

test(
  'board_train_session_content parses as BoardTrainSessionContentWire (§14.2-A runtime pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    const body = await fetchReport(FIXTURE_IDS.reportBoardTrainId);
    assert.equal(body['program'], 'board-train-session');
    // The wire aliases this to BoardingSessionContentWire. Asserting it with
    // the SAME validator is the pin on that alias: the day the two shapes
    // diverge in the emission, this fails and the alias must be split.
    assertStayContent('board_train_session_content', body['board_train_session_content']);
  },
);

test(
  'group_class_session_content parses as GroupClassSessionContentWire (§14.2-A runtime pin)',
  SKIP_WHEN_NO_DB,
  async () => {
    const body = await fetchReport(FIXTURE_IDS.reportGroupClassId);
    assert.equal(body['program'], 'group-class-session');
    assertGroupClassContent('group_class_session_content', body['group_class_session_content']);
  },
);

test(
  'exactly one variant key is emitted, and a curriculum report emits none',
  SKIP_WHEN_NO_DB,
  async () => {
    const VARIANT_KEYS = [
      'private_lesson_content',
      'boarding_session_content',
      'board_train_session_content',
      'group_class_session_content',
    ] as const;

    for (const id of [
      FIXTURE_IDS.reportPrivateLessonId,
      FIXTURE_IDS.reportBoardingId,
      FIXTURE_IDS.reportBoardTrainId,
      FIXTURE_IDS.reportGroupClassId,
    ]) {
      const body = await fetchReport(id);
      const present = VARIANT_KEYS.filter((k) => k in body);
      assert.equal(
        present.length,
        1,
        `report ${id}: expected 1 variant key, got ${present.join()}`,
      );
    }

    const curriculum = await fetchReport(FIXTURE_IDS.reportFoundationId);
    assert.equal(curriculum['program'], 'foundation');
    const strays = VARIANT_KEYS.filter((k) => k in curriculum);
    assert.deepStrictEqual(strays, [], 'a curriculum report must carry no variant doc');
  },
);
