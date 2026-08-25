import { assertNever } from './assertNever.js';
import { pgTimestampToIso } from './pgTimestamp.js';
import { reportProgram } from '../db/schema/schema.js';
import type { ServiceCategory } from './bookingBucket.js';
import type {
  SkillResult,
  PracticeItem,
  ReportWire,
  PrivateLessonContentWire,
  BoardingSessionContentWire,
  BoardTrainSessionContentWire,
  GroupClassSessionContentWire,
} from '../contracts/wire.js';

/**
 * Wire shape for `Report` per DATA-CONTRACT §B Report (R2 JSONB
 * rehydration). The DB stores curriculum keys in `reports.results` JSONB
 * (envelope: `{ results?, practice_at_home?, friends_today?,
 * additional_skills_completed? }` — pinned Day 6b §A clarification) and
 * the variant doc in `reports.content` JSONB. This helper spreads the
 * envelope to four top-level sibling keys and emits the variant doc
 * under the program-derived variant key (`private_lesson_content` |
 * `boarding_session_content` | `board_train_session_content` |
 * `group_class_session_content`).
 *
 * The switch over `program` uses `assertNever` so a future enum value
 * lands as a compile error rather than a silent drop — the Day-5b pattern
 * from `creditsRepository`.
 *
 * Curriculum-key shapes are passed through verbatim from JSONB to the
 * wire — the FE's `to*Content` translators expect snake_case (the mock-
 * data shape). Day-12 (report mutation, R2 write) pins the Zod validator
 * that authors must satisfy; reads emit whatever's stored.
 */
export type ReportProgram = (typeof reportProgram.enumValues)[number];

// These wire shapes are owned by the single-source contract (contracts/wire.ts).
export type { SkillResult, PracticeItem, ReportWire };

/** The subset of `reports` columns the wire helper consumes. */
export interface ReportRowForWire {
  id: string;
  dogId: string;
  date: string;
  category: ServiceCategory;
  program: ReportProgram;
  excerpt: string;
  fullText: string;
  visitCount: number | null;
  verdictHeadline: string | null;
  results: unknown;
  content: unknown;
}

/**
 * Emit the §B wire shape. Trainer name is pre-resolved by the route via
 * `staffRepository.findNamesByIds`; `null`/empty → omit (the day-care
 * "no trainer" branch).
 */
export function toReportWire(row: ReportRowForWire, trainerName: string | null): ReportWire {
  const wire: ReportWire = {
    id: row.id,
    dog_id: row.dogId,
    date: pgTimestampToIso(row.date),
    category: row.category,
    program: row.program,
    excerpt: row.excerpt,
    full_text: row.fullText,
  };
  if (trainerName !== null && trainerName !== '') wire.trainer = trainerName;
  if (row.visitCount !== null) wire.visit_count = row.visitCount;
  if (row.verdictHeadline !== null && row.verdictHeadline !== '') {
    wire.verdict_headline = row.verdictHeadline;
  }
  spreadCurriculumEnvelope(row.results, wire);
  attachVariantContent(row.program, row.content, wire);
  return wire;
}

/**
 * Shape stored in the `reports.results` JSONB column (per §A
 * Clarification 2026-05-20). Schema-locked at the boundary; the helper
 * trusts whatever's stored — Day-12 Zod write-side validator is the
 * gate that keeps this shape honest. Treat anything that violates it
 * as a structural bug (loud throw) rather than silently coercing.
 */
interface ReportResultsEnvelope {
  results?: Record<string, SkillResult>;
  practice_at_home?: PracticeItem[];
  friends_today?: string[];
  additional_skills_completed?: string[];
}

/**
 * Cast `reports.results` JSONB to the envelope shape, or `null` if the
 * column is empty. One trust boundary instead of four inner `as` casts.
 */
function asEnvelope(raw: unknown): ReportResultsEnvelope | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(
      `reportWire: reports.results JSONB must be an object envelope; got ${typeof raw}`,
    );
  }
  return raw as ReportResultsEnvelope;
}

/**
 * Spread the `reports.results` JSONB envelope into the four sibling
 * curriculum keys on the wire. Each key is independently optional-omit
 * (undefined → omit; empty array/object → omit). The envelope itself
 * is NULL when a report carries no curriculum data at all (a boarding-
 * session row, for example).
 */
function spreadCurriculumEnvelope(rawResults: unknown, wire: ReportWire): void {
  const envelope = asEnvelope(rawResults);
  if (envelope === null) return;

  if (envelope.results !== undefined && Object.keys(envelope.results).length > 0) {
    wire.results = envelope.results;
  }
  if (envelope.practice_at_home !== undefined && envelope.practice_at_home.length > 0) {
    wire.practice_at_home = envelope.practice_at_home;
  }
  if (envelope.friends_today !== undefined && envelope.friends_today.length > 0) {
    wire.friends_today = envelope.friends_today;
  }
  if (
    envelope.additional_skills_completed !== undefined &&
    envelope.additional_skills_completed.length > 0
  ) {
    wire.additional_skills_completed = envelope.additional_skills_completed;
  }
}

/**
 * Cast the `reports.content` JSONB to a program's variant-doc wire type. One
 * trust boundary instead of four inner `as` casts — the same contract
 * `asEnvelope` keeps for the `results` envelope above.
 *
 * Unlike `asEnvelope` this deliberately does NOT throw on a non-object. The
 * column is opaque the whole way down: the write path validates only
 * `z.record(z.unknown())` (`routes/staffReports.ts:75`) and the schema CHECK
 * asserts presence, never shape (`schema.sql:591-596`). Adding a guard here
 * would turn a storable row into a 500 — a behavior change, which a promotion
 * may not make (designs/wire-contract-completion.md §14.1).
 *
 * So the four `*ContentWire` types transcribe what is EMITTED (pinned byte-wise
 * by `test/contracts/snapshots/report-{private-lesson,boarding,board-train,
 * group-class}.json`, and structurally by
 * `test/contracts/report-content-types.test.ts`) — they are NOT enforced on
 * write. That gap is DISCREPANCIES BUG-13; closing it is write-side validation,
 * filed, not enacted here. This corrects the module doc above, which claims
 * "Day-12 … pins the Zod validator that authors must satisfy" — no such
 * validator exists (digest reports fix/S, phase 3).
 */
function asVariantContent<T>(content: unknown): T {
  return content as T;
}

/**
 * Attach the variant doc under the program-keyed wire field, or no
 * variant key for curriculum programs. The switch is exhaustive over
 * `report_program`; `assertNever` catches a future enum addition at
 * compile time.
 */
function attachVariantContent(program: ReportProgram, content: unknown, wire: ReportWire): void {
  switch (program) {
    case 'foundation':
    case 'advanced':
    case 'loose-leash':
    case 'house-manners':
    case 'cgc':
      // Curriculum programs carry no variant doc. The schema CHECK forbids
      // `content` for these — even if present, we don't emit it.
      return;
    case 'private-lesson':
      wire.private_lesson_content = asVariantContent<PrivateLessonContentWire>(content);
      return;
    case 'boarding-session':
      wire.boarding_session_content = asVariantContent<BoardingSessionContentWire>(content);
      return;
    case 'board-train-session':
      wire.board_train_session_content = asVariantContent<BoardTrainSessionContentWire>(content);
      return;
    case 'group-class-session':
      wire.group_class_session_content = asVariantContent<GroupClassSessionContentWire>(content);
      return;
    default:
      assertNever(program);
  }
}
