/**
 * Compile-time conformance: the literal enum unions in `wire.ts` MUST equal the
 * canonical Drizzle enums (`schema.sql` → `pgEnum`). This file is API-only — it
 * imports Drizzle, so it is never copied to the portal. If `schema.sql` adds or
 * removes an enum value, `db:introspect` regenerates the Drizzle enum and the
 * matching `Equal<…>` below flips to `false`, turning `Expect<false>` into a
 * `tsc` error until `wire.ts` is brought back in line. That is the whole point:
 * drift between the DB and the wire contract becomes a build failure.
 *
 * (We assert rather than rewire `pgEnum(...)` to import `wire.ts` tuples because
 * `schema.ts` is drizzle-introspection-generated — a `db:introspect` pull would
 * clobber any hand-wired import.)
 */
import {
  serviceCategory,
  bookingStatus,
  requestStatus,
  threadCategory,
  chargeStatus,
  reportProgram,
  rateUnit,
  staffRole,
  checkinEventKind,
  mediaPurpose,
  mediaKind,
  notificationType,
  bookingMode,
  evaluationStatus,
  groupClassKey,
  refundStatus,
  invoiceStatus,
  chargePurpose,
  announcementCategory,
  recordSource,
  LOCATION_SLUGS,
} from '../db/schema/schema.js';
import type {
  ServiceCategory,
  BookingStatus,
  RequestStatus,
  ThreadCategory,
  ChargeStatus,
  ReportProgram,
  RateUnit,
  StaffRole,
  CheckinEventKind,
  MediaPurpose,
  MediaKind,
  NotificationType,
  BookingMode,
  EvaluationStatus,
  GroupClassKey,
  RefundStatus,
  InvoiceStatus,
  ChargePurpose,
  AnnouncementCategory,
  LocationKey,
  RecordSource,
} from './wire.js';

type Expect<T extends true> = T;
// Invariant (bidirectional) equality — `extends` alone would miss a wire union
// that is a strict subset/superset of the DB enum.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type DrizzleEnum<E extends { enumValues: readonly string[] }> = E['enumValues'][number];

/**
 * One entry per shared enum. A `false` anywhere fails this type, which fails the
 * build. Exported so it counts as used (and so the failing member is named in
 * the error). `CheckinEventKind` is the check-in log's `checkin_event_kind`
 * (M5.12, 6.0.0-lg5.1): the folded `AttendanceStatus` has no pgEnum, so nothing
 * pins it; `LocationKey` is backed by the `LOCATION_SLUGS` text tuple, not a
 * `pgEnum`; `ComfortLevel` is intentionally absent (no DB enum — it was retired
 * in favour of `descriptor_keys`).
 */
export type ContractEnumConformance = [
  Expect<Equal<ServiceCategory, DrizzleEnum<typeof serviceCategory>>>,
  Expect<Equal<BookingStatus, DrizzleEnum<typeof bookingStatus>>>,
  Expect<Equal<RequestStatus, DrizzleEnum<typeof requestStatus>>>,
  Expect<Equal<ThreadCategory, DrizzleEnum<typeof threadCategory>>>,
  Expect<Equal<ChargeStatus, DrizzleEnum<typeof chargeStatus>>>,
  Expect<Equal<ReportProgram, DrizzleEnum<typeof reportProgram>>>,
  Expect<Equal<RateUnit, DrizzleEnum<typeof rateUnit>>>,
  Expect<Equal<StaffRole, DrizzleEnum<typeof staffRole>>>,
  Expect<Equal<MediaPurpose, DrizzleEnum<typeof mediaPurpose>>>,
  Expect<Equal<MediaKind, DrizzleEnum<typeof mediaKind>>>,
  Expect<Equal<NotificationType, DrizzleEnum<typeof notificationType>>>,
  // M5.12 (6.0.0-lg5.1): the log's six kinds replace the `booking_attendance` pin.
  Expect<Equal<CheckinEventKind, DrizzleEnum<typeof checkinEventKind>>>,
  Expect<Equal<LocationKey, (typeof LOCATION_SLUGS)[number]>>,
  // 1.13.0 skeleton (§5.3): the three shared unions promoted into wire.ts §2.
  Expect<Equal<BookingMode, DrizzleEnum<typeof bookingMode>>>,
  Expect<Equal<EvaluationStatus, DrizzleEnum<typeof evaluationStatus>>>,
  Expect<Equal<GroupClassKey, DrizzleEnum<typeof groupClassKey>>>,
  // 1.13.0 lane CONFORMANCE ADDs (§8): pgEnum-backed unions promoted by the
  // refunds, payments-invoices, and notifications lanes.
  Expect<Equal<RefundStatus, DrizzleEnum<typeof refundStatus>>>,
  Expect<Equal<InvoiceStatus, DrizzleEnum<typeof invoiceStatus>>>,
  Expect<Equal<ChargePurpose, DrizzleEnum<typeof chargePurpose>>>,
  Expect<Equal<AnnouncementCategory, DrizzleEnum<typeof announcementCategory>>>,
  // 2.0.0 (P03): `StaffOwnerWire.source` puts `record_source` on the wire.
  Expect<Equal<RecordSource, DrizzleEnum<typeof recordSource>>>,
];
