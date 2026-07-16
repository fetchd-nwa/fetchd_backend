import { pgTable, text, doublePrecision, boolean, timestamp, uniqueIndex, foreignKey, unique, uuid, jsonb, index, check, date, integer, smallint, bigint, primaryKey, pgView, pgEnum } from "drizzle-orm/pg-core"
import { sql } from "drizzle-orm"

export const announcementCategory = pgEnum("announcement_category", ['urgent', 'team', 'class', 'event', 'promo', 'report'])
export const bookingAttendance = pgEnum("booking_attendance", ['pending', 'attended', 'no-show', 'excused'])
export const bookingMode = pgEnum("booking_mode", ['school', 'daycare'])
export const bookingStatus = pgEnum("booking_status", ['upcoming', 'past', 'cancelled'])
export const chargePurpose = pgEnum("charge_purpose", ['package', 'payg', 'board-train', 'membership', 'group-class'])
export const chargeStatus = pgEnum("charge_status", ['requires_payment', 'succeeded', 'failed', 'refunded'])
export const evaluationStatus = pgEnum("evaluation_status", ['not-evaluated', 'pending', 'passed', 'failed'])
export const groupClassKey = pgEnum("group_class_key", ['puppy', 'manners-1', 'manners-2', 'public-pups'])
export const invoiceStatus = pgEnum("invoice_status", ['open', 'paid', 'void'])
export const ledgerReason = pgEnum("ledger_reason", ['purchase', 'booking-debit', 'cancel-refund', 'adjustment', 'membership-grant'])
// Locations are a table since the Δ 2026-06-08 (was the `location_key`/`app_location`
// enums). `slug` is the natural key + the wire value; `LOCATION_SLUGS` is the TS
// tuple for z.enum validation (replaces the old LOCATION_SLUGS).
export const LOCATION_SLUGS = ['fayetteville', 'bentonville'] as const;
export type LocationKey = (typeof LOCATION_SLUGS)[number];
export const mediaDerivativeJobStatus = pgEnum("media_derivative_job_status", ['pending', 'processing', 'done', 'failed'])
export const mediaKind = pgEnum("media_kind", ['image', 'video'])
export const mediaPurpose = pgEnum("media_purpose", ['dog-profile', 'owner-avatar', 'report-photo', 'report-video', 'message-attachment'])
export const notificationType = pgEnum("notification_type", ['booking-confirmed', 'report-published', 'booking-cancelled', 'announcement', 'message-received', 'booking-reminder', 'boarding-profile-check', 'credits-expiring', 'payment-failed', 'payment-succeeded', 'alumni-attendance', 'membership-ended', 'spay-neuter-reminder'])
export const rateUnit = pgEnum("rate_unit", ['per-day', 'per-night', 'per-session', 'per-week', 'flat'])
export const recordSource = pgEnum("record_source", ['app', 'gingr', 'seed'])
export const refundStatus = pgEnum("refund_status", ['pending', 'succeeded', 'failed'])
export const reportProgram = pgEnum("report_program", ['foundation', 'advanced', 'loose-leash', 'house-manners', 'cgc', 'private-lesson', 'boarding-session', 'group-class-session', 'board-train-session'])
export const requestStatus = pgEnum("request_status", ['submitted', 'approved', 'approved-awaiting-payment', 'converted', 'cancelled'])
export const scheduledStatus = pgEnum("scheduled_status", ['pending', 'sent', 'cancelled'])
export const senderKind = pgEnum("sender_kind", ['owner', 'staff'])
export const serviceCategory = pgEnum("service_category", ['day-school', 'day-care', 'group-class', 'private-lesson', 'board-and-train', 'boarding', 'evaluation'])
export const staffRole = pgEnum("staff_role", ['owner-shanthi', 'trainer', 'office'])
export const threadCategory = pgEnum("thread_category", ['sessions', 'billing', 'enrollment', 'other'])


export const locations = pgTable("locations", {
	slug: text().primaryKey().notNull(),
	displayName: text("display_name").notNull(),
	address: text(),
	latitude: doublePrecision(),
	longitude: doublePrecision(),
	timezone: text().default('America/Chicago').notNull(),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
});

export const owners = pgTable("owners", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	supabaseUid: uuid("supabase_uid").notNull(),
	name: text().notNull(),
	email: text().notNull(),
	phone: text().notNull(),
	location: text().$type<LocationKey>().notNull(),
	avatarImagePath: text("avatar_image_path"),
	emergencyName: text("emergency_name"),
	emergencyRelationship: text("emergency_relationship"),
	emergencyPhone: text("emergency_phone"),
	addressLine1: text("address_line1"),
	addressLine2: text("address_line2"),
	addressCity: text("address_city"),
	addressState: text("address_state"),
	addressZip: text("address_zip"),
	pushNotificationsEnabled: boolean("push_notifications_enabled").default(true).notNull(),
	pushNotificationCategories: jsonb("push_notification_categories").default({}).notNull(),
	emailNotificationsEnabled: boolean("email_notifications_enabled").default(true).notNull(),
	emailNotificationCategories: jsonb("email_notification_categories").default({}).notNull(),
	showDogsOnWelcome: boolean("show_dogs_on_welcome").default(true).notNull(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		sourceRefUidx: uniqueIndex("owners_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalRef.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		ownersLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "owners_location_fkey"
		}),
		ownersSupabaseUidKey: unique("owners_supabase_uid_key").on(table.supabaseUid),
	}
});

export const staff = pgTable("staff", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	supabaseUid: uuid("supabase_uid").notNull(),
	name: text().notNull(),
	role: staffRole().notNull(),
	location: text().$type<LocationKey>(),
	imagePath: text("image_path"),
	active: boolean().default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		staffLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "staff_location_fkey"
		}),
		staffSupabaseUidKey: unique("staff_supabase_uid_key").on(table.supabaseUid),
	}
});

export const dogs = pgTable("dogs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id"),
	staffOwnerId: uuid("staff_owner_id"),
	name: text().notNull(),
	breed: text().notNull(),
	birthdate: date(),
	ageMonthsOverride: integer("age_months_override"),
	profileImagePath: text("profile_image_path"),
	specialNotes: text("special_notes").default('').notNull(),
	evaluationStatus: evaluationStatus("evaluation_status").default('not-evaluated').notNull(),
	evaluationDate: timestamp("evaluation_date", { withTimezone: true, mode: 'string' }),
	boardingEnabled: boolean("boarding_enabled").default(false).notNull(),
	// §J.3: set by the monthly alumni attendance scan (<2 qualifying sessions
	// in the closed Chicago month); cleared by staff after the re-check.
	alumniAttendanceFlaggedAt: timestamp("alumni_attendance_flagged_at", { withTimezone: true, mode: 'string' }),
	// Shanthi 2026-07-14: profile question, never a hard block. NULL =
	// unanswered; FALSE diverts day-program bookings to the approval lane.
	spayedNeutered: boolean("spayed_neutered"),
	spayNeuterPlannedOn: date("spay_neuter_planned_on"),
	fieldOverrides: jsonb("field_overrides").default({}).notNull(),
	primaryVetId: uuid("primary_vet_id"),
	capacityExempt: boolean("capacity_exempt").generatedAlwaysAs(sql`(staff_owner_id IS NOT NULL)`),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		ownerIdx: index("dogs_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		primaryVetIdx: index("dogs_primary_vet_idx").using("btree", table.primaryVetId.asc().nullsLast().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("dogs_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalRef.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		staffOwnerIdx: index("dogs_staff_owner_idx").using("btree", table.staffOwnerId.asc().nullsLast().op("uuid_ops")),
		dogsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "dogs_owner_id_fkey"
		}).onDelete("restrict"),
		dogsStaffOwnerIdFkey: foreignKey({
			columns: [table.staffOwnerId],
			foreignColumns: [staff.id],
			name: "dogs_staff_owner_id_fkey"
		}).onDelete("restrict"),
		dogsPrimaryVetFk: foreignKey({
			columns: [table.primaryVetId],
			foreignColumns: [vets.id],
			name: "dogs_primary_vet_fk"
		}).onDelete("set null"),
		dogsCheck: check("dogs_check", sql`(birthdate IS NOT NULL) OR (age_months_override IS NOT NULL)`),
		dogsCheck1: check("dogs_check1", sql`(owner_id IS NOT NULL) <> (staff_owner_id IS NOT NULL)`),
	}
});

export const vets = pgTable("vets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	phone: text(),
	email: text(),
	address: text(),
	notes: text(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		sourceRefUidx: uniqueIndex("vets_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalRef.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
	}
});

export const dogVaccines = pgTable("dog_vaccines", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dogId: uuid("dog_id").notNull(),
	name: text().notNull(),
	requirementKey: text("requirement_key"),
	expiresAt: date("expires_at").notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogIdx: index("dog_vaccines_dog_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops")),
		reqIdx: index("dog_vaccines_req_idx").using("btree", table.dogId.asc().nullsLast().op("text_ops"), table.requirementKey.asc().nullsLast().op("text_ops")).where(sql`((requirement_key IS NOT NULL) AND (expired_at IS NULL))`),
		dogVaccinesDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "dog_vaccines_dog_id_fkey"
		}).onDelete("cascade"),
		dogVaccinesRequirementKeyFkey: foreignKey({
			columns: [table.requirementKey],
			foreignColumns: [requiredVaccines.key],
			name: "dog_vaccines_requirement_key_fkey"
		}),
	}
});

export const requiredVaccines = pgTable("required_vaccines", {
	key: text().primaryKey().notNull(),
	label: text().notNull(),
	gatesCategories: serviceCategory("gates_categories").array().notNull(),
	// Shanthi 2026-07-14: group-class bookings whose cohort's class_key is
	// listed here skip this vaccine (puppy classes don't require rabies).
	exemptClassKeys: groupClassKey("exempt_class_keys").array().default([]).notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
});

export const dogMedications = pgTable("dog_medications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dogId: uuid("dog_id").notNull(),
	name: text().notNull(),
	dose: text().notNull(),
	frequency: text().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogIdx: index("dog_medications_dog_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops")),
		dogMedicationsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "dog_medications_dog_id_fkey"
		}).onDelete("cascade"),
	}
});

export const dogFeeding = pgTable("dog_feeding", {
	dogId: uuid("dog_id").primaryKey().notNull(),
	brand: text().notNull(),
	amount: text().notNull(),
	frequency: text().notNull(),
	notes: text(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogFeedingDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "dog_feeding_dog_id_fkey"
		}).onDelete("cascade"),
	}
});

export const dogCompletedClasses = pgTable("dog_completed_classes", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dogId: uuid("dog_id").notNull(),
	classKey: groupClassKey("class_key").notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		uidx: uniqueIndex("dog_completed_classes_uidx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops"), table.classKey.asc().nullsLast().op("uuid_ops")).where(sql`(expired_at IS NULL)`),
		dogCompletedClassesDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "dog_completed_classes_dog_id_fkey"
		}).onDelete("cascade"),
	}
});

// §J.3 (2026-07-09): the "5 day-school courses" a dog completed — the 5
// curriculum report_program values. Staff-authored; alumni = all 5 live rows.
export const dogCompletedPrograms = pgTable("dog_completed_programs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dogId: uuid("dog_id").notNull(),
	program: reportProgram().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedByStaffId: uuid("completed_by_staff_id"),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		uidx: uniqueIndex("dog_completed_programs_uidx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops"), table.program.asc().nullsLast().op("enum_ops")).where(sql`(expired_at IS NULL)`),
		dogCompletedProgramsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "dog_completed_programs_dog_id_fkey"
		}).onDelete("cascade"),
		dogCompletedProgramsStaffFkey: foreignKey({
			columns: [table.completedByStaffId],
			foreignColumns: [staff.id],
			name: "dog_completed_programs_completed_by_staff_id_fkey"
		}).onDelete("restrict"),
		dogCompletedProgramsProgramCheck: check("dog_completed_programs_program_check", sql`program IN ('foundation', 'advanced', 'loose-leash', 'house-manners', 'cgc')`),
	}
});

export const groupClasses = pgTable("group_classes", {
	key: groupClassKey().primaryKey().notNull(),
	name: text().notNull(),
	weeks: integer().notNull(),
	pricePerDogCents: integer("price_per_dog_cents").notNull(),
	capacity: integer().notNull(),
	ageRange: text("age_range"),
	description: text().notNull(),
	enrollmentType: text("enrollment_type").notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		groupClassesWeeksCheck: check("group_classes_weeks_check", sql`weeks > 0`),
		groupClassesPricePerDogCentsCheck: check("group_classes_price_per_dog_cents_check", sql`price_per_dog_cents >= 0`),
		groupClassesCapacityCheck: check("group_classes_capacity_check", sql`capacity > 0`),
		groupClassesEnrollmentTypeCheck: check("group_classes_enrollment_type_check", sql`enrollment_type = ANY (ARRAY['open'::text, 'cohort'::text])`),
	}
});

export const classPrereqOptions = pgTable("class_prereq_options", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	classKey: groupClassKey("class_key").notNull(),
	prereqClassKey: groupClassKey("prereq_class_key").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		classIdx: index("class_prereq_options_class_idx").using("btree", table.classKey.asc().nullsLast().op("enum_ops")),
		uidx: uniqueIndex("class_prereq_options_uidx").using("btree", table.classKey.asc().nullsLast().op("enum_ops"), table.prereqClassKey.asc().nullsLast().op("enum_ops")).where(sql`(expired_at IS NULL)`),
		classPrereqOptionsClassKeyFkey: foreignKey({
			columns: [table.classKey],
			foreignColumns: [groupClasses.key],
			name: "class_prereq_options_class_key_fkey"
		}).onDelete("cascade"),
		classPrereqOptionsPrereqClassKeyFkey: foreignKey({
			columns: [table.prereqClassKey],
			foreignColumns: [groupClasses.key],
			name: "class_prereq_options_prereq_class_key_fkey"
		}),
	}
});

export const classResources = pgTable("class_resources", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	classKey: groupClassKey("class_key").notNull(),
	title: text().notNull(),
	subtitle: text(),
	deepLinkPath: text("deep_link_path").notNull(),
	position: smallint().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		classIdx: index("class_resources_class_idx").using("btree", table.classKey.asc().nullsLast().op("enum_ops")).where(sql`(expired_at IS NULL)`),
		uidx: uniqueIndex("class_resources_uidx").using("btree", table.classKey.asc().nullsLast().op("text_ops"), table.deepLinkPath.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		classResourcesClassKeyFkey: foreignKey({
			columns: [table.classKey],
			foreignColumns: [groupClasses.key],
			name: "class_resources_class_key_fkey"
		}).onDelete("cascade"),
	}
});

export const cohorts = pgTable("cohorts", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	classKey: groupClassKey("class_key").notNull(),
	location: text().$type<LocationKey>().notNull(),
	startDate: timestamp("start_date", { withTimezone: true, mode: 'string' }).notNull(),
	endDate: timestamp("end_date", { withTimezone: true, mode: 'string' }),
	weeklyTime: text("weekly_time").notNull(),
	weeks: integer().notNull(),
	capacity: integer().notNull(),
	filled: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		classIdx: index("cohorts_class_idx").using("btree", table.classKey.asc().nullsLast().op("enum_ops")),
		cohortsClassKeyFkey: foreignKey({
			columns: [table.classKey],
			foreignColumns: [groupClasses.key],
			name: "cohorts_class_key_fkey"
		}),
		cohortsLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "cohorts_location_fkey"
		}),
		cohortsWeeksCheck: check("cohorts_weeks_check", sql`weeks > 0`),
		cohortsCapacityCheck: check("cohorts_capacity_check", sql`capacity > 0`),
		cohortsFilledCheck: check("cohorts_filled_check", sql`filled >= 0`),
		cohortsCheck: check("cohorts_check", sql`filled <= capacity`),
	}
});

export const reports = pgTable("reports", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dogId: uuid("dog_id").notNull(),
	date: timestamp({ withTimezone: true, mode: 'string' }).notNull(),
	trainerStaffId: uuid("trainer_staff_id"),
	category: serviceCategory().notNull(),
	program: reportProgram().notNull(),
	excerpt: text().notNull(),
	fullText: text("full_text").notNull(),
	visitCount: integer("visit_count"),
	verdictHeadline: text("verdict_headline"),
	results: jsonb(),
	content: jsonb(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogDateIdx: index("reports_dog_date_idx").using("btree", table.dogId.asc().nullsLast().op("timestamptz_ops"), table.date.desc().nullsFirst().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("reports_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalRef.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		reportsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "reports_dog_id_fkey"
		}).onDelete("cascade"),
		reportsTrainerStaffIdFkey: foreignKey({
			columns: [table.trainerStaffId],
			foreignColumns: [staff.id],
			name: "reports_trainer_staff_id_fkey"
		}),
		reportsCheck: check("reports_check", sql`((program = ANY (ARRAY['private-lesson'::report_program, 'boarding-session'::report_program, 'board-train-session'::report_program, 'group-class-session'::report_program])) AND (content IS NOT NULL)) OR (program = ANY (ARRAY['foundation'::report_program, 'advanced'::report_program, 'loose-leash'::report_program, 'house-manners'::report_program, 'cgc'::report_program]))`),
	}
});

export const mediaAssets = pgTable("media_assets", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	dogId: uuid("dog_id"),
	reportId: uuid("report_id"),
	kind: mediaKind().notNull(),
	purpose: mediaPurpose().notNull(),
	objectKey: text("object_key").notNull(),
	contentType: text("content_type").notNull(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	bytes: bigint({ mode: "number" }).notNull(),
	width: integer(),
	height: integer(),
	durationMs: integer("duration_ms"),
	blurhash: text(),
	derivatives: jsonb().default([]).notNull(),
	createdBy: senderKind("created_by").notNull(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogIdx: index("media_assets_dog_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops")),
		ownerIdx: index("media_assets_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		reportIdx: index("media_assets_report_idx").using("btree", table.reportId.asc().nullsLast().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("media_assets_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("enum_ops"), table.externalRef.asc().nullsLast().op("enum_ops")).where(sql`(expired_at IS NULL)`),
		mediaAssetsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "media_assets_owner_id_fkey"
		}).onDelete("cascade"),
		mediaAssetsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "media_assets_dog_id_fkey"
		}).onDelete("cascade"),
		mediaAssetsReportIdFkey: foreignKey({
			columns: [table.reportId],
			foreignColumns: [reports.id],
			name: "media_assets_report_id_fkey"
		}).onDelete("cascade"),
	}
});

export const mediaDerivativeJobs = pgTable("media_derivative_jobs", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	mediaAssetId: uuid("media_asset_id").notNull(),
	status: mediaDerivativeJobStatus().default('pending').notNull(),
	attempts: integer().default(0).notNull(),
	lastError: text("last_error"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		pendingIdx: index("media_derivative_jobs_pending_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::media_derivative_job_status)`),
		mediaDerivativeJobsMediaAssetIdFkey: foreignKey({
			columns: [table.mediaAssetId],
			foreignColumns: [mediaAssets.id],
			name: "media_derivative_jobs_media_asset_id_fkey"
		}).onDelete("cascade"),
		mediaDerivativeJobsMediaAssetIdKey: unique("media_derivative_jobs_media_asset_id_key").on(table.mediaAssetId),
	}
});

export const bookings = pgTable("bookings", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	leadDogId: uuid("lead_dog_id").notNull(),
	category: serviceCategory().notNull(),
	status: bookingStatus().default('upcoming').notNull(),
	scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: 'string' }).notNull(),
	durationMinutes: integer("duration_minutes"),
	trainerStaffId: uuid("trainer_staff_id"),
	notes: text(),
	cohortId: uuid("cohort_id"),
	reportId: uuid("report_id"),
	sessionReportId: uuid("session_report_id"),
	confirmedAt: timestamp("confirmed_at", { withTimezone: true, mode: 'string' }),
	dropoffAt: timestamp("dropoff_at", { withTimezone: true, mode: 'string' }),
	pickupAt: timestamp("pickup_at", { withTimezone: true, mode: 'string' }),
	location: text().$type<LocationKey>(),
	cancelledAt: timestamp("cancelled_at", { withTimezone: true, mode: 'string' }),
	cancellationReason: text("cancellation_reason"),
	cancelDeadlineAt: timestamp("cancel_deadline_at", { withTimezone: true, mode: 'string' }),
	cancelForfeited: boolean("cancel_forfeited").default(false).notNull(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		cohortIdx: index("bookings_cohort_idx").using("btree", table.cohortId.asc().nullsLast().op("uuid_ops")),
		dropoffIdx: index("bookings_dropoff_idx").using("btree", table.dropoffAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(dropoff_at IS NOT NULL)`),
		leadDogIdx: index("bookings_lead_dog_idx").using("btree", table.leadDogId.asc().nullsLast().op("uuid_ops"), table.scheduledAt.asc().nullsLast().op("uuid_ops")),
		locationTimeIdx: index("bookings_location_time_idx").using("btree", table.location.asc().nullsLast().op("text_ops"), table.scheduledAt.asc().nullsLast().op("text_ops")),
		ownerIdx: index("bookings_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("bookings_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("enum_ops"), table.externalRef.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		statusTimeIdx: index("bookings_status_time_idx").using("btree", table.status.asc().nullsLast().op("enum_ops"), table.scheduledAt.asc().nullsLast().op("timestamptz_ops")),
		bookingsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "bookings_owner_id_fkey"
		}).onDelete("restrict"),
		bookingsLeadDogIdFkey: foreignKey({
			columns: [table.leadDogId],
			foreignColumns: [dogs.id],
			name: "bookings_lead_dog_id_fkey"
		}),
		bookingsTrainerStaffIdFkey: foreignKey({
			columns: [table.trainerStaffId],
			foreignColumns: [staff.id],
			name: "bookings_trainer_staff_id_fkey"
		}),
		bookingsCohortIdFkey: foreignKey({
			columns: [table.cohortId],
			foreignColumns: [cohorts.id],
			name: "bookings_cohort_id_fkey"
		}),
		bookingsReportIdFkey: foreignKey({
			columns: [table.reportId],
			foreignColumns: [reports.id],
			name: "bookings_report_id_fkey"
		}),
		bookingsSessionReportIdFkey: foreignKey({
			columns: [table.sessionReportId],
			foreignColumns: [reports.id],
			name: "bookings_session_report_id_fkey"
		}),
		bookingsLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "bookings_location_fkey"
		}),
		bookingsCheck: check("bookings_check", sql`(category = 'group-class'::service_category) = (cohort_id IS NOT NULL)`),
		bookingsCheck1: check("bookings_check1", sql`(dropoff_at IS NULL) OR (category = ANY (ARRAY['boarding'::service_category, 'board-and-train'::service_category]))`),
	}
});

export const afterSchoolOptins = pgTable("after_school_optins", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	bookingId: uuid("booking_id").notNull(),
	bookingCategory: serviceCategory("booking_category").notNull(),
	dogId: uuid("dog_id").notNull(),
	ownerId: uuid("owner_id").notNull(),
	schoolDayCount: integer("school_day_count").notNull(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogIdx: index("after_school_optins_dog_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops")),
		ownerIdx: index("after_school_optins_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("after_school_optins_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("text_ops"), table.externalRef.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		uidx: uniqueIndex("after_school_optins_uidx").using("btree", table.bookingId.asc().nullsLast().op("uuid_ops"), table.dogId.asc().nullsLast().op("uuid_ops")).where(sql`(expired_at IS NULL)`),
		afterSchoolOptinsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "after_school_optins_dog_id_fkey"
		}).onDelete("cascade"),
		afterSchoolOptinsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "after_school_optins_owner_id_fkey"
		}).onDelete("cascade"),
		afterSchoolOptinsBookingIdBookingCategoryFkey: foreignKey({
			columns: [table.bookingId, table.bookingCategory],
			foreignColumns: [bookings.id, bookings.category],
			name: "after_school_optins_booking_id_booking_category_fkey"
		}).onDelete("cascade"),
		afterSchoolOptinsSchoolDayCountCheck: check("after_school_optins_school_day_count_check", sql`school_day_count > 0`),
		afterSchoolOptinsBookingCategoryCheck: check("after_school_optins_booking_category_check", sql`booking_category = 'day-school'::service_category`),
	}
});

export const pendingRequests = pgTable("pending_requests", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	leadDogId: uuid("lead_dog_id").notNull(),
	category: serviceCategory().notNull(),
	status: requestStatus().default('submitted').notNull(),
	submittedAt: timestamp("submitted_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	notesPerDog: text("notes_per_dog"),
	notesJoint: text("notes_joint"),
	staffPreference: text("staff_preference"),
	descriptorKeys: text("descriptor_keys").array().default([]).notNull(),
	lengthWeeks: integer("length_weeks"),
	// Day-program divert (Shanthi 2026-07-14): what the approve conversion
	// needs to create the day-school/day-care bookings. NULL/empty on the
	// classic request categories.
	location: text().$type<LocationKey>(),
	payment: text().$type<'credits' | 'payg'>(),
	paymentMethodId: uuid("payment_method_id"),
	divertReasons: text("divert_reasons").array().default([]).notNull(),
	approvedAt: timestamp("approved_at", { withTimezone: true, mode: 'string' }),
	approvedByStaffId: uuid("approved_by_staff_id"),
	convertedBookingId: uuid("converted_booking_id"),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		ownerIdx: index("pending_requests_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("pending_requests_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("enum_ops"), table.externalRef.asc().nullsLast().op("enum_ops")).where(sql`(expired_at IS NULL)`),
		statusIdx: index("pending_requests_status_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")),
		pendingRequestsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "pending_requests_owner_id_fkey"
		}).onDelete("restrict"),
		pendingRequestsLeadDogIdFkey: foreignKey({
			columns: [table.leadDogId],
			foreignColumns: [dogs.id],
			name: "pending_requests_lead_dog_id_fkey"
		}),
		pendingRequestsApprovedByStaffIdFkey: foreignKey({
			columns: [table.approvedByStaffId],
			foreignColumns: [staff.id],
			name: "pending_requests_approved_by_staff_id_fkey"
		}),
		pendingRequestsConvertedBookingIdFkey: foreignKey({
			columns: [table.convertedBookingId],
			foreignColumns: [bookings.id],
			name: "pending_requests_converted_booking_id_fkey"
		}),
	}
});

export const intakeFieldSettings = pgTable("intake_field_settings", {
	fieldKey: text("field_key").primaryKey().notNull(),
	collected: boolean().default(true).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedByStaffId: uuid("updated_by_staff_id"),
}, (table) => {
	return {
		intakeFieldSettingsUpdatedByStaffIdFkey: foreignKey({
			columns: [table.updatedByStaffId],
			foreignColumns: [staff.id],
			name: "intake_field_settings_updated_by_staff_id_fkey"
		}).onDelete("set null"),
	}
});

export const cancelWindowSettings = pgTable("cancel_window_settings", {
	category: serviceCategory().primaryKey().notNull(),
	hoursBefore: integer("hours_before").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedByStaffId: uuid("updated_by_staff_id"),
}, (table) => {
	return {
		cancelWindowSettingsUpdatedByStaffIdFkey: foreignKey({
			columns: [table.updatedByStaffId],
			foreignColumns: [staff.id],
			name: "cancel_window_settings_updated_by_staff_id_fkey"
		}).onDelete("set null"),
		cancelWindowSettingsHoursBeforeCheck: check("cancel_window_settings_hours_before_check", sql`hours_before > 0`),
	}
});

export const dogDescriptors = pgTable("dog_descriptors", {
	key: text().primaryKey().notNull(),
	label: text().notNull(),
	sortOrder: integer("sort_order").default(0).notNull(),
	active: boolean().default(true).notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedByStaffId: uuid("updated_by_staff_id"),
}, (table) => {
	return {
		dogDescriptorsUpdatedByStaffIdFkey: foreignKey({
			columns: [table.updatedByStaffId],
			foreignColumns: [staff.id],
			name: "dog_descriptors_updated_by_staff_id_fkey"
		}).onDelete("set null"),
	}
});

export const creditExpirySettings = pgTable("credit_expiry_settings", {
	location: text().$type<LocationKey>(),
	expiryWindowMonths: integer("expiry_window_months").notNull(),
	warningLeadDays: integer("warning_lead_days").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedByStaffId: uuid("updated_by_staff_id"),
}, (table) => {
	return {
		locationUniq: uniqueIndex("credit_expiry_settings_location_uniq").using("btree", table.location.asc().nullsLast().op("text_ops")).where(sql`(location IS NOT NULL)`),
		orgDefaultUniq: uniqueIndex("credit_expiry_settings_org_default_uniq").using("btree", sql`(location IS NULL)`).where(sql`(location IS NULL)`),
		creditExpirySettingsLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "credit_expiry_settings_location_fkey"
		}),
		creditExpirySettingsUpdatedByStaffIdFkey: foreignKey({
			columns: [table.updatedByStaffId],
			foreignColumns: [staff.id],
			name: "credit_expiry_settings_updated_by_staff_id_fkey"
		}).onDelete("set null"),
		creditExpirySettingsExpiryWindowMonthsCheck: check("credit_expiry_settings_expiry_window_months_check", sql`expiry_window_months > 0`),
		creditExpirySettingsWarningLeadDaysCheck: check("credit_expiry_settings_warning_lead_days_check", sql`warning_lead_days >= 0`),
	}
});

export const creditPackages = pgTable("credit_packages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	key: text().notNull(),
	location: text().$type<LocationKey>().notNull(),
	mode: bookingMode().notNull(),
	credits: integer().notNull(),
	priceCents: integer("price_cents").notNull(),
	label: text().notNull(),
	isPopular: boolean("is_popular").default(false).notNull(),
	effectiveFrom: date("effective_from").default(sql`CURRENT_DATE`).notNull(),
	effectiveTo: date("effective_to"),
}, (table) => {
	return {
		creditPackagesLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "credit_packages_location_fkey"
		}),
		creditPackagesKeyLocationEffectiveFromKey: unique("credit_packages_key_location_effective_from_key").on(table.key, table.location, table.effectiveFrom),
		creditPackagesCreditsCheck: check("credit_packages_credits_check", sql`credits > 0`),
		creditPackagesPriceCentsCheck: check("credit_packages_price_cents_check", sql`price_cents >= 0`),
	}
});

export const creditLedger = pgTable("credit_ledger", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	dogId: uuid("dog_id").notNull(),
	mode: bookingMode().notNull(),
	location: text().$type<LocationKey>().notNull(),
	delta: integer().notNull(),
	reason: ledgerReason().notNull(),
	bookingId: uuid("booking_id"),
	packageId: uuid("package_id"),
	chargeId: uuid("charge_id"),
	expiresAt: timestamp("expires_at", { withTimezone: true, mode: 'string' }),
	lotId: uuid("lot_id"),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		dogModeIdx: index("credit_ledger_dog_mode_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops"), table.mode.asc().nullsLast().op("text_ops"), table.location.asc().nullsLast().op("uuid_ops")),
		lotFifoIdx: index("credit_ledger_lot_fifo_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops"), table.mode.asc().nullsLast().op("timestamptz_ops"), table.location.asc().nullsLast().op("enum_ops"), table.expiresAt.asc().nullsLast().op("uuid_ops")).where(sql`((delta > 0) AND (lot_id IS NULL))`),
		lotIdIdx: index("credit_ledger_lot_id_idx").using("btree", table.lotId.asc().nullsLast().op("uuid_ops")).where(sql`(lot_id IS NOT NULL)`),
		creditLedgerDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "credit_ledger_dog_id_fkey"
		}).onDelete("restrict"),
		creditLedgerLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "credit_ledger_location_fkey"
		}),
		creditLedgerBookingIdFkey: foreignKey({
			columns: [table.bookingId],
			foreignColumns: [bookings.id],
			name: "credit_ledger_booking_id_fkey"
		}),
		creditLedgerPackageIdFkey: foreignKey({
			columns: [table.packageId],
			foreignColumns: [creditPackages.id],
			name: "credit_ledger_package_id_fkey"
		}),
		creditLedgerLotIdFkey: foreignKey({
			columns: [table.lotId],
			foreignColumns: [table.id],
			name: "credit_ledger_lot_id_fkey"
		}),
		creditLedgerChargeFk: foreignKey({
			columns: [table.chargeId],
			foreignColumns: [charges.id],
			name: "credit_ledger_charge_fk"
		}),
	}
});

export const stripeCustomers = pgTable("stripe_customers", {
	ownerId: uuid("owner_id").primaryKey().notNull(),
	stripeCustomerId: text("stripe_customer_id").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		stripeCustomersOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "stripe_customers_owner_id_fkey"
		}).onDelete("restrict"),
		stripeCustomersStripeCustomerIdKey: unique("stripe_customers_stripe_customer_id_key").on(table.stripeCustomerId),
	}
});

export const paymentMethods = pgTable("payment_methods", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	stripePaymentMethodId: text("stripe_payment_method_id").notNull(),
	brand: text().notNull(),
	last4: text().notNull(),
	expMonth: smallint("exp_month").notNull(),
	expYear: smallint("exp_year").notNull(),
	cardholderName: text("cardholder_name").notNull(),
	isDefault: boolean("is_default").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		oneDefault: uniqueIndex("payment_methods_one_default").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")).where(sql`(is_default AND (expired_at IS NULL))`),
		ownerIdx: index("payment_methods_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		paymentMethodsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "payment_methods_owner_id_fkey"
		}).onDelete("restrict"),
		paymentMethodsStripePaymentMethodIdKey: unique("payment_methods_stripe_payment_method_id_key").on(table.stripePaymentMethodId),
		paymentMethodsExpMonthCheck: check("payment_methods_exp_month_check", sql`(exp_month >= 1) AND (exp_month <= 12)`),
	}
});

export const charges = pgTable("charges", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	stripePaymentIntentId: text("stripe_payment_intent_id"),
	amountCents: integer("amount_cents").notNull(),
	currency: text().default('usd').notNull(),
	status: chargeStatus().default('requires_payment').notNull(),
	purpose: chargePurpose().notNull(),
	bookingId: uuid("booking_id"),
	cohortId: uuid("cohort_id"),
	dogId: uuid("dog_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		ownerIdx: index("charges_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		chargesOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "charges_owner_id_fkey"
		}).onDelete("restrict"),
		chargesBookingIdFkey: foreignKey({
			columns: [table.bookingId],
			foreignColumns: [bookings.id],
			name: "charges_booking_id_fkey"
		}),
		chargesCohortIdFkey: foreignKey({
			columns: [table.cohortId],
			foreignColumns: [cohorts.id],
			name: "charges_cohort_id_fkey"
		}),
		chargesDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "charges_dog_id_fkey"
		}),
		chargesStripePaymentIntentIdKey: unique("charges_stripe_payment_intent_id_key").on(table.stripePaymentIntentId),
		chargesAmountCentsCheck: check("charges_amount_cents_check", sql`amount_cents >= 0`),
	}
});

export const invoices = pgTable("invoices", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	amountCents: integer("amount_cents").notNull(),
	currency: text().default('usd').notNull(),
	status: invoiceStatus().default('open').notNull(),
	purpose: chargePurpose().notNull(),
	bookingId: uuid("booking_id"),
	cohortId: uuid("cohort_id"),
	dogId: uuid("dog_id"),
	requestId: uuid("request_id"),
	// §J.1: set on purpose='membership' rows — the subscription month billed.
	membershipId: uuid("membership_id"),
	paymentMethodId: uuid("payment_method_id").notNull(),
	paidChargeId: uuid("paid_charge_id"),
	issuedAt: timestamp("issued_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	dueAt: timestamp("due_at", { withTimezone: true, mode: 'string' }).notNull(),
	nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true, mode: 'string' }),
	autoChargeAttempts: integer("auto_charge_attempts").default(0).notNull(),
	paidAt: timestamp("paid_at", { withTimezone: true, mode: 'string' }),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
}, (table) => {
	return {
		openIdx: index("invoices_open_idx").using("btree", table.status.asc().nullsLast().op("enum_ops")).where(sql`(status = 'open'::invoice_status)`),
		ownerIdx: index("invoices_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		invoicesOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "invoices_owner_id_fkey"
		}).onDelete("restrict"),
		invoicesBookingIdFkey: foreignKey({
			columns: [table.bookingId],
			foreignColumns: [bookings.id],
			name: "invoices_booking_id_fkey"
		}).onDelete("set null"),
		invoicesCohortIdFkey: foreignKey({
			columns: [table.cohortId],
			foreignColumns: [cohorts.id],
			name: "invoices_cohort_id_fkey"
		}).onDelete("set null"),
		invoicesDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "invoices_dog_id_fkey"
		}).onDelete("set null"),
		invoicesRequestIdFkey: foreignKey({
			columns: [table.requestId],
			foreignColumns: [pendingRequests.id],
			name: "invoices_request_id_fkey"
		}).onDelete("set null"),
		invoicesMembershipIdFkey: foreignKey({
			columns: [table.membershipId],
			foreignColumns: [memberships.id],
			name: "invoices_membership_id_fkey"
		}).onDelete("set null"),
		invoicesPaymentMethodIdFkey: foreignKey({
			columns: [table.paymentMethodId],
			foreignColumns: [paymentMethods.id],
			name: "invoices_payment_method_id_fkey"
		}).onDelete("restrict"),
		invoicesPaidChargeIdFkey: foreignKey({
			columns: [table.paidChargeId],
			foreignColumns: [charges.id],
			name: "invoices_paid_charge_id_fkey"
		}),
		invoicesSourceExternalRefKey: unique("invoices_source_external_ref_key").on(table.externalRef, table.source),
		invoicesAmountCentsCheck: check("invoices_amount_cents_check", sql`amount_cents >= 0`),
		invoicesCheck: check("invoices_check", sql`(status <> 'paid'::invoice_status) OR (paid_at IS NOT NULL)`),
	}
});

// §J.1 ACTIVATED 2026-07-09: a membership is a credit-package subscription —
// self-billed monthly via the invoice auto-charge lane (NOT Stripe Billing;
// stripe_subscription_id stays NULL), hard-stopping at ends_at. See schema.sql.
export const memberships = pgTable("memberships", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	dogId: uuid("dog_id"),
	mode: bookingMode().notNull(),
	packageId: uuid("package_id"),
	termMonths: integer("term_months"),
	paymentMethodId: uuid("payment_method_id"),
	stripeSubscriptionId: text("stripe_subscription_id"),
	status: text().default('active').notNull(),
	startedAt: timestamp("started_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	currentPeriodStart: timestamp("current_period_start", { withTimezone: true, mode: 'string' }),
	currentPeriodEnd: timestamp("current_period_end", { withTimezone: true, mode: 'string' }),
	endsAt: timestamp("ends_at", { withTimezone: true, mode: 'string' }),
	pausedAt: timestamp("paused_at", { withTimezone: true, mode: 'string' }),
	pausedByStaffId: uuid("paused_by_staff_id"),
}, (table) => {
	return {
		ownerIdx: index("memberships_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		activeRollIdx: index("memberships_active_roll_idx").using("btree", table.currentPeriodEnd.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'active'::text)`),
		membershipsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "memberships_owner_id_fkey"
		}).onDelete("restrict"),
		membershipsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "memberships_dog_id_fkey"
		}).onDelete("restrict"),
		membershipsPackageIdFkey: foreignKey({
			columns: [table.packageId],
			foreignColumns: [creditPackages.id],
			name: "memberships_package_id_fkey"
		}).onDelete("restrict"),
		membershipsPaymentMethodIdFkey: foreignKey({
			columns: [table.paymentMethodId],
			foreignColumns: [paymentMethods.id],
			name: "memberships_payment_method_id_fkey"
		}).onDelete("restrict"),
		membershipsPausedByStaffIdFkey: foreignKey({
			columns: [table.pausedByStaffId],
			foreignColumns: [staff.id],
			name: "memberships_paused_by_staff_id_fkey"
		}).onDelete("restrict"),
		membershipsStripeSubscriptionIdKey: unique("memberships_stripe_subscription_id_key").on(table.stripeSubscriptionId),
		membershipsTermMonthsCheck: check("memberships_term_months_check", sql`term_months IN (3, 6, 9, 12)`),
	}
});

export const refunds = pgTable("refunds", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	chargeId: uuid("charge_id").notNull(),
	bookingId: uuid("booking_id"),
	stripeRefundId: text("stripe_refund_id"),
	amountCents: integer("amount_cents").notNull(),
	reason: text(),
	status: refundStatus().default('pending').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		chargeIdx: index("refunds_charge_idx").using("btree", table.chargeId.asc().nullsLast().op("uuid_ops")),
		ownerIdx: index("refunds_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops")),
		refundsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "refunds_owner_id_fkey"
		}).onDelete("restrict"),
		refundsChargeIdFkey: foreignKey({
			columns: [table.chargeId],
			foreignColumns: [charges.id],
			name: "refunds_charge_id_fkey"
		}).onDelete("restrict"),
		refundsBookingIdFkey: foreignKey({
			columns: [table.bookingId],
			foreignColumns: [bookings.id],
			name: "refunds_booking_id_fkey"
		}),
		refundsStripeRefundIdKey: unique("refunds_stripe_refund_id_key").on(table.stripeRefundId),
		refundsAmountCentsCheck: check("refunds_amount_cents_check", sql`amount_cents > 0`),
	}
});

export const stripeEvents = pgTable("stripe_events", {
	eventId: text("event_id").primaryKey().notNull(),
	eventType: text("event_type").notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	processedAt: timestamp("processed_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		typeReceivedIdx: index("stripe_events_type_received_idx").using("btree", table.eventType.asc().nullsLast().op("text_ops"), table.receivedAt.desc().nullsFirst().op("text_ops")),
		unprocessedIdx: index("stripe_events_unprocessed_idx").using("btree", table.receivedAt.asc().nullsLast().op("timestamptz_ops")).where(sql`(processed_at IS NULL)`),
	}
});

export const serviceRates = pgTable("service_rates", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	category: serviceCategory().notNull(),
	location: text().$type<LocationKey>(),
	amountCents: integer("amount_cents").notNull(),
	unit: rateUnit().notNull(),
	effectiveFrom: date("effective_from").notNull(),
	effectiveTo: date("effective_to"),
	note: text(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	createdByStaffId: uuid("created_by_staff_id"),
	voidedAt: timestamp("voided_at", { withTimezone: true, mode: 'string' }),
	voidedByStaffId: uuid("voided_by_staff_id"),
}, (table) => {
	return {
		lookupIdx: index("service_rates_lookup_idx").using("btree", table.category.asc().nullsLast().op("enum_ops"), table.location.asc().nullsLast().op("date_ops"), table.effectiveFrom.desc().nullsFirst().op("enum_ops")),
		serviceRatesLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "service_rates_location_fkey"
		}),
		serviceRatesCreatedByStaffIdFkey: foreignKey({
			columns: [table.createdByStaffId],
			foreignColumns: [staff.id],
			name: "service_rates_created_by_staff_id_fkey"
		}).onDelete("set null"),
		serviceRatesVoidedByStaffIdFkey: foreignKey({
			columns: [table.voidedByStaffId],
			foreignColumns: [staff.id],
			name: "service_rates_voided_by_staff_id_fkey"
		}).onDelete("set null"),
		serviceRatesAmountCentsCheck: check("service_rates_amount_cents_check", sql`amount_cents >= 0`),
		serviceRatesCheck: check("service_rates_check", sql`(effective_to IS NULL) OR (effective_to > effective_from)`),
	}
});

export const agreementSignatures = pgTable("agreement_signatures", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	documentKey: text("document_key").notNull(),
	version: integer().notNull(),
	signedAt: timestamp("signed_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	ip: text(),
	userAgent: text("user_agent"),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
}, (table) => {
	return {
		ownerIdx: index("agreement_signatures_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("uuid_ops"), table.documentKey.asc().nullsLast().op("uuid_ops")),
		agreementSignaturesOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "agreement_signatures_owner_id_fkey"
		}).onDelete("restrict"),
		agreementSignaturesDocumentKeyFkey: foreignKey({
			columns: [table.documentKey],
			foreignColumns: [agreementDocuments.key],
			name: "agreement_signatures_document_key_fkey"
		}),
		agreementSignaturesOwnerIdDocumentKeyVersionKey: unique("agreement_signatures_owner_id_document_key_version_key").on(table.ownerId, table.documentKey, table.version),
		agreementSignaturesVersionCheck: check("agreement_signatures_version_check", sql`version > 0`),
	}
});

export const agreementDocuments = pgTable("agreement_documents", {
	key: text().primaryKey().notNull(),
	label: text().notNull(),
	currentVersion: integer("current_version").notNull(),
	required: boolean().default(true).notNull(),
	appliesTo: serviceCategory("applies_to").array().default([]).notNull(),
	bodyUrl: text("body_url"),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		agreementDocumentsCurrentVersionCheck: check("agreement_documents_current_version_check", sql`current_version > 0`),
	}
});

export const idempotencyKeys = pgTable("idempotency_keys", {
	key: text().primaryKey().notNull(),
	ownerId: uuid("owner_id"),
	endpoint: text().notNull(),
	requestHash: text("request_hash").notNull(),
	responseStatus: integer("response_status"),
	responseBody: jsonb("response_body"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	completedAt: timestamp("completed_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		createdIdx: index("idempotency_keys_created_idx").using("btree", table.createdAt.asc().nullsLast().op("timestamptz_ops")),
		idempotencyKeysOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "idempotency_keys_owner_id_fkey"
		}).onDelete("cascade"),
	}
});

export const threads = pgTable("threads", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	participantStaffId: uuid("participant_staff_id"),
	category: threadCategory().notNull(),
	title: text().notNull(),
	subText: text("sub_text").notNull(),
	lastMessage: text("last_message").default('').notNull(),
	lastMessageAt: timestamp("last_message_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	externalRef: text("external_ref"),
	source: recordSource().default('app').notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		ownerIdx: index("threads_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("timestamptz_ops"), table.lastMessageAt.desc().nullsFirst().op("uuid_ops")),
		sourceRefUidx: uniqueIndex("threads_source_ref_uidx").using("btree", table.source.asc().nullsLast().op("enum_ops"), table.externalRef.asc().nullsLast().op("enum_ops")).where(sql`(expired_at IS NULL)`),
		threadsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "threads_owner_id_fkey"
		}).onDelete("cascade"),
		threadsParticipantStaffIdFkey: foreignKey({
			columns: [table.participantStaffId],
			foreignColumns: [staff.id],
			name: "threads_participant_staff_id_fkey"
		}),
	}
});

export const messages = pgTable("messages", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	threadId: uuid("thread_id").notNull(),
	senderKind: senderKind("sender_kind").notNull(),
	senderOwnerId: uuid("sender_owner_id"),
	senderStaffId: uuid("sender_staff_id"),
	text: text().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		threadIdx: index("messages_thread_idx").using("btree", table.threadId.asc().nullsLast().op("timestamptz_ops"), table.sentAt.asc().nullsLast().op("timestamptz_ops")),
		messagesThreadIdFkey: foreignKey({
			columns: [table.threadId],
			foreignColumns: [threads.id],
			name: "messages_thread_id_fkey"
		}).onDelete("cascade"),
		messagesSenderOwnerIdFkey: foreignKey({
			columns: [table.senderOwnerId],
			foreignColumns: [owners.id],
			name: "messages_sender_owner_id_fkey"
		}),
		messagesSenderStaffIdFkey: foreignKey({
			columns: [table.senderStaffId],
			foreignColumns: [staff.id],
			name: "messages_sender_staff_id_fkey"
		}),
		messagesCheck: check("messages_check", sql`((sender_kind = 'owner'::sender_kind) AND (sender_owner_id IS NOT NULL) AND (sender_staff_id IS NULL)) OR ((sender_kind = 'staff'::sender_kind) AND (sender_staff_id IS NOT NULL) AND (sender_owner_id IS NULL))`),
	}
});

export const messageAttachments = pgTable("message_attachments", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	messageId: uuid("message_id").notNull(),
	mediaAssetId: uuid("media_asset_id").notNull(),
	position: integer().default(0).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		messageIdx: index("message_attachments_message_idx").using("btree", table.messageId.asc().nullsLast().op("int4_ops"), table.position.asc().nullsLast().op("int4_ops")),
		messageMediaUidx: uniqueIndex("message_attachments_message_media_uidx").using("btree", table.messageId.asc().nullsLast().op("uuid_ops"), table.mediaAssetId.asc().nullsLast().op("uuid_ops")),
		messageAttachmentsMessageIdFkey: foreignKey({
			columns: [table.messageId],
			foreignColumns: [messages.id],
			name: "message_attachments_message_id_fkey"
		}).onDelete("cascade"),
		messageAttachmentsMediaAssetIdFkey: foreignKey({
			columns: [table.mediaAssetId],
			foreignColumns: [mediaAssets.id],
			name: "message_attachments_media_asset_id_fkey"
		}),
	}
});

export const eventSeries = pgTable("event_series", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	cadence: text().notNull(),
	defaultDurationMinutes: integer("default_duration_minutes"),
	description: text(),
	isActive: boolean("is_active").default(true).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
});

export const events = pgTable("events", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	name: text().notNull(),
	startsAt: timestamp("starts_at", { withTimezone: true, mode: 'string' }).notNull(),
	durationMinutes: integer("duration_minutes").notNull(),
	locLabel: text("loc_label").notNull(),
	locAddress: text("loc_address").notNull(),
	locLatitude: doublePrecision("loc_latitude").notNull(),
	locLongitude: doublePrecision("loc_longitude").notNull(),
	description: text(),
	isRecurring: boolean("is_recurring").default(false).notNull(),
	seriesId: uuid("series_id"),
	capacity: integer(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		eventsSeriesIdFkey: foreignKey({
			columns: [table.seriesId],
			foreignColumns: [eventSeries.id],
			name: "events_series_id_fkey"
		}),
	}
});

export const eventRsvps = pgTable("event_rsvps", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	eventId: uuid("event_id").notNull(),
	ownerId: uuid("owner_id").notNull(),
	rsvpdAt: timestamp("rsvpd_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		uidx: uniqueIndex("event_rsvps_uidx").using("btree", table.eventId.asc().nullsLast().op("uuid_ops"), table.ownerId.asc().nullsLast().op("uuid_ops")).where(sql`(expired_at IS NULL)`),
		eventRsvpsEventIdFkey: foreignKey({
			columns: [table.eventId],
			foreignColumns: [events.id],
			name: "event_rsvps_event_id_fkey"
		}).onDelete("cascade"),
		eventRsvpsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "event_rsvps_owner_id_fkey"
		}).onDelete("cascade"),
	}
});

export const notifications = pgTable("notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	type: notificationType().notNull(),
	title: text().notNull(),
	body: text().notNull(),
	receivedAt: timestamp("received_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	readAt: timestamp("read_at", { withTimezone: true, mode: 'string' }),
	deepLinkPath: text("deep_link_path"),
	senderStaffId: uuid("sender_staff_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		ownerIdx: index("notifications_owner_idx").using("btree", table.ownerId.asc().nullsLast().op("timestamptz_ops"), table.receivedAt.desc().nullsFirst().op("timestamptz_ops")),
		notificationsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "notifications_owner_id_fkey"
		}).onDelete("cascade"),
		notificationsSenderStaffIdFkey: foreignKey({
			columns: [table.senderStaffId],
			foreignColumns: [staff.id],
			name: "notifications_sender_staff_id_fkey"
		}),
	}
});

export const scheduledNotifications = pgTable("scheduled_notifications", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	type: notificationType().notNull(),
	trigger: text().notNull(),
	dedupeKey: text("dedupe_key"),
	scheduledFor: timestamp("scheduled_for", { withTimezone: true, mode: 'string' }).notNull(),
	status: scheduledStatus().default('pending').notNull(),
	title: text().notNull(),
	body: text().notNull(),
	deepLinkPath: text("deep_link_path"),
	bookingId: uuid("booking_id"),
	reportId: uuid("report_id"),
	dogId: uuid("dog_id"),
	emittedNotificationId: uuid("emitted_notification_id"),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	sentAt: timestamp("sent_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dueIdx: index("scheduled_notifications_due_idx").using("btree", table.scheduledFor.asc().nullsLast().op("timestamptz_ops")).where(sql`(status = 'pending'::scheduled_status)`),
		scheduledNotificationsOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "scheduled_notifications_owner_id_fkey"
		}).onDelete("cascade"),
		scheduledNotificationsBookingIdFkey: foreignKey({
			columns: [table.bookingId],
			foreignColumns: [bookings.id],
			name: "scheduled_notifications_booking_id_fkey"
		}).onDelete("cascade"),
		scheduledNotificationsReportIdFkey: foreignKey({
			columns: [table.reportId],
			foreignColumns: [reports.id],
			name: "scheduled_notifications_report_id_fkey"
		}).onDelete("cascade"),
		scheduledNotificationsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "scheduled_notifications_dog_id_fkey"
		}).onDelete("cascade"),
		scheduledNotificationsEmittedNotificationIdFkey: foreignKey({
			columns: [table.emittedNotificationId],
			foreignColumns: [notifications.id],
			name: "scheduled_notifications_emitted_notification_id_fkey"
		}),
		scheduledNotificationsDedupeKeyKey: unique("scheduled_notifications_dedupe_key_key").on(table.dedupeKey),
	}
});

export const announcements = pgTable("announcements", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	category: announcementCategory().notNull(),
	title: text().notNull(),
	body: text(),
	publishedAt: timestamp("published_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	deepLinkPath: text("deep_link_path"),
	ctaLabel: text("cta_label"),
	// CHECK (cta_kind IN ('enroll','route','external')) enforces this at the DB;
	// $type reflects that guarantee at compile time so reads narrow without a cast.
	ctaKind: text("cta_kind").$type<'enroll' | 'route' | 'external'>(),
	ctaTarget: text("cta_target"),
	targetLocation: text("target_location").$type<LocationKey>(),
	isPinned: boolean("is_pinned").default(false).notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		announcementsTargetLocationFkey: foreignKey({
			columns: [table.targetLocation],
			foreignColumns: [locations.slug],
			name: "announcements_target_location_fkey"
		}),
		announcementsCtaKindCheck: check("announcements_cta_kind_check", sql`cta_kind = ANY (ARRAY['enroll'::text, 'route'::text, 'external'::text])`),
		announcementsCtaAllOrNone: check("announcements_cta_all_or_none", sql`((cta_label IS NULL) AND (cta_kind IS NULL) AND (cta_target IS NULL)) OR ((cta_label IS NOT NULL) AND (cta_kind IS NOT NULL) AND (cta_target IS NOT NULL))`),
	}
});

export const deviceTokens = pgTable("device_tokens", {
	id: uuid().defaultRandom().primaryKey().notNull(),
	ownerId: uuid("owner_id").notNull(),
	expoPushToken: text("expo_push_token").notNull(),
	platform: text().notNull(),
	createdAt: timestamp("created_at", { withTimezone: true, mode: 'string' }).defaultNow().notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		uidx: uniqueIndex("device_tokens_uidx").using("btree", table.ownerId.asc().nullsLast().op("text_ops"), table.expoPushToken.asc().nullsLast().op("text_ops")).where(sql`(expired_at IS NULL)`),
		deviceTokensOwnerIdFkey: foreignKey({
			columns: [table.ownerId],
			foreignColumns: [owners.id],
			name: "device_tokens_owner_id_fkey"
		}).onDelete("cascade"),
		deviceTokensPlatformCheck: check("device_tokens_platform_check", sql`platform = ANY (ARRAY['ios'::text, 'android'::text])`),
	}
});

export const auditLog = pgTable("audit_log", {
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	id: bigint({ mode: "number" }).primaryKey().generatedAlwaysAsIdentity({ name: "audit_log_id_seq", startWith: 1, increment: 1, minValue: 1, maxValue: 9223372036854775807, cache: 1 }),
	tableName: text("table_name").notNull(),
	rowPk: text("row_pk").notNull(),
	op: text().notNull(),
	before: jsonb().notNull(),
	actor: text(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	txid: bigint({ mode: "number" }).default(sql`txid_current()`).notNull(),
	at: timestamp({ withTimezone: true, mode: 'string' }).defaultNow().notNull(),
}, (table) => {
	return {
		tableRowIdx: index("audit_log_table_row_idx").using("btree", table.tableName.asc().nullsLast().op("text_ops"), table.rowPk.asc().nullsLast().op("timestamptz_ops"), table.at.desc().nullsFirst().op("text_ops")),
	}
});

export const notificationDogs = pgTable("notification_dogs", {
	notificationId: uuid("notification_id").notNull(),
	dogId: uuid("dog_id").notNull(),
}, (table) => {
	return {
		notificationDogsNotificationIdFkey: foreignKey({
			columns: [table.notificationId],
			foreignColumns: [notifications.id],
			name: "notification_dogs_notification_id_fkey"
		}).onDelete("cascade"),
		notificationDogsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "notification_dogs_dog_id_fkey"
		}).onDelete("cascade"),
		notificationDogsPkey: primaryKey({ columns: [table.notificationId, table.dogId], name: "notification_dogs_pkey"}),
	}
});

export const threadDogs = pgTable("thread_dogs", {
	threadId: uuid("thread_id").notNull(),
	dogId: uuid("dog_id").notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		threadDogsThreadIdFkey: foreignKey({
			columns: [table.threadId],
			foreignColumns: [threads.id],
			name: "thread_dogs_thread_id_fkey"
		}).onDelete("cascade"),
		threadDogsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "thread_dogs_dog_id_fkey"
		}).onDelete("cascade"),
		threadDogsPkey: primaryKey({ columns: [table.threadId, table.dogId], name: "thread_dogs_pkey"}),
	}
});

export const eventRsvpDogs = pgTable("event_rsvp_dogs", {
	rsvpId: uuid("rsvp_id").notNull(),
	dogId: uuid("dog_id").notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		eventRsvpDogsRsvpIdFkey: foreignKey({
			columns: [table.rsvpId],
			foreignColumns: [eventRsvps.id],
			name: "event_rsvp_dogs_rsvp_id_fkey"
		}).onDelete("cascade"),
		eventRsvpDogsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "event_rsvp_dogs_dog_id_fkey"
		}).onDelete("cascade"),
		eventRsvpDogsPkey: primaryKey({ columns: [table.rsvpId, table.dogId], name: "event_rsvp_dogs_pkey"}),
	}
});

export const pendingRequestDogs = pgTable("pending_request_dogs", {
	requestId: uuid("request_id").notNull(),
	dogId: uuid("dog_id").notNull(),
	isLead: boolean("is_lead").default(false).notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		pendingRequestDogsRequestIdFkey: foreignKey({
			columns: [table.requestId],
			foreignColumns: [pendingRequests.id],
			name: "pending_request_dogs_request_id_fkey"
		}).onDelete("cascade"),
		pendingRequestDogsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "pending_request_dogs_dog_id_fkey"
		}).onDelete("cascade"),
		pendingRequestDogsPkey: primaryKey({ columns: [table.requestId, table.dogId], name: "pending_request_dogs_pkey"}),
	}
});

export const pendingRequestPreferredDates = pgTable("pending_request_preferred_dates", {
	requestId: uuid("request_id").notNull(),
	ordinal: smallint().notNull(),
	preferredAt: timestamp("preferred_at", { withTimezone: true, mode: 'string' }).notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		pendingRequestPreferredDatesRequestIdFkey: foreignKey({
			columns: [table.requestId],
			foreignColumns: [pendingRequests.id],
			name: "pending_request_preferred_dates_request_id_fkey"
		}).onDelete("cascade"),
		pendingRequestPreferredDatesPkey: primaryKey({ columns: [table.requestId, table.ordinal], name: "pending_request_preferred_dates_pkey"}),
	}
});

export const dayCapacity = pgTable("day_capacity", {
	location: text().$type<LocationKey>().notNull(),
	date: date().notNull(),
	schoolOpenings: integer("school_openings").notNull(),
	daycareOpenings: integer("daycare_openings").notNull(),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dayCapacityLocationFkey: foreignKey({
			columns: [table.location],
			foreignColumns: [locations.slug],
			name: "day_capacity_location_fkey"
		}),
		dayCapacityPkey: primaryKey({ columns: [table.location, table.date], name: "day_capacity_pkey"}),
		dayCapacitySchoolOpeningsCheck: check("day_capacity_school_openings_check", sql`school_openings >= 0`),
		dayCapacityDaycareOpeningsCheck: check("day_capacity_daycare_openings_check", sql`daycare_openings >= 0`),
	}
});

export const bookingDogs = pgTable("booking_dogs", {
	bookingId: uuid("booking_id").notNull(),
	dogId: uuid("dog_id").notNull(),
	isLead: boolean("is_lead").default(false).notNull(),
	attendance: bookingAttendance().default('pending').notNull(),
	checkedInAt: timestamp("checked_in_at", { withTimezone: true, mode: 'string' }),
	checkedInByStaffId: uuid("checked_in_by_staff_id"),
	expiredAt: timestamp("expired_at", { withTimezone: true, mode: 'string' }),
}, (table) => {
	return {
		dogIdx: index("booking_dogs_dog_idx").using("btree", table.dogId.asc().nullsLast().op("uuid_ops")),
		bookingDogsBookingIdFkey: foreignKey({
			columns: [table.bookingId],
			foreignColumns: [bookings.id],
			name: "booking_dogs_booking_id_fkey"
		}).onDelete("cascade"),
		bookingDogsDogIdFkey: foreignKey({
			columns: [table.dogId],
			foreignColumns: [dogs.id],
			name: "booking_dogs_dog_id_fkey"
		}).onDelete("cascade"),
		bookingDogsCheckedInByStaffIdFkey: foreignKey({
			columns: [table.checkedInByStaffId],
			foreignColumns: [staff.id],
			name: "booking_dogs_checked_in_by_staff_id_fkey"
		}),
		bookingDogsPkey: primaryKey({ columns: [table.bookingId, table.dogId], name: "booking_dogs_pkey"}),
	}
});
export const dogCreditBalance = pgView("dog_credit_balance", {	dogId: uuid("dog_id"),
	mode: bookingMode(),
	location: text().$type<LocationKey>(),
	// You can use { mode: "bigint" } if numbers are exceeding js number limitations
	balance: bigint({ mode: "number" }),
}).as(sql`SELECT cl.dog_id, cl.mode, cl.location, COALESCE(sum(cl.delta), 0::bigint) AS balance FROM credit_ledger cl LEFT JOIN credit_ledger lot ON lot.id = cl.lot_id WHERE CASE WHEN cl.lot_id IS NOT NULL THEN lot.expires_at IS NULL OR lot.expires_at > now() WHEN cl.delta > 0 THEN cl.expires_at IS NULL OR cl.expires_at > now() ELSE true END GROUP BY cl.dog_id, cl.mode, cl.location`);