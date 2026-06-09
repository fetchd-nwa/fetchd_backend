import { relations } from "drizzle-orm/relations";
import { owners, dogs, staff, vets, dogVaccines, requiredVaccines, dogMedications, dogFeeding, dogCompletedClasses, groupClasses, classPrereqOptions, cohorts, reports, mediaAssets, bookings, afterSchoolOptins, pendingRequests, cancelWindowSettings, creditLedger, creditPackages, charges, paymentMethods, stripeCustomers, invoices, memberships, agreementSignatures, agreementDocuments, refunds, idempotencyKeys, threads, notifications, messages, eventSeries, events, eventRsvps, scheduledNotifications, deviceTokens, notificationDogs, threadDogs, eventRsvpDogs, pendingRequestDogs, pendingRequestPreferredDates, bookingDogs } from "./schema.js";

export const dogsRelations = relations(dogs, ({one, many}) => ({
	owner: one(owners, {
		fields: [dogs.ownerId],
		references: [owners.id]
	}),
	staff: one(staff, {
		fields: [dogs.staffOwnerId],
		references: [staff.id]
	}),
	vet: one(vets, {
		fields: [dogs.primaryVetId],
		references: [vets.id]
	}),
	dogVaccines: many(dogVaccines),
	dogMedications: many(dogMedications),
	dogFeedings: many(dogFeeding),
	dogCompletedClasses: many(dogCompletedClasses),
	reports: many(reports),
	mediaAssets: many(mediaAssets),
	bookings: many(bookings),
	afterSchoolOptins: many(afterSchoolOptins),
	pendingRequests: many(pendingRequests),
	creditLedgers: many(creditLedger),
	memberships: many(memberships),
	scheduledNotifications: many(scheduledNotifications),
	notificationDogs: many(notificationDogs),
	threadDogs: many(threadDogs),
	eventRsvpDogs: many(eventRsvpDogs),
	pendingRequestDogs: many(pendingRequestDogs),
	bookingDogs: many(bookingDogs),
}));

export const ownersRelations = relations(owners, ({many}) => ({
	dogs: many(dogs),
	mediaAssets: many(mediaAssets),
	bookings: many(bookings),
	afterSchoolOptins: many(afterSchoolOptins),
	pendingRequests: many(pendingRequests),
	paymentMethods: many(paymentMethods),
	stripeCustomers: many(stripeCustomers),
	charges: many(charges),
	invoices: many(invoices),
	memberships: many(memberships),
	agreementSignatures: many(agreementSignatures),
	refunds: many(refunds),
	idempotencyKeys: many(idempotencyKeys),
	threads: many(threads),
	notifications: many(notifications),
	messages: many(messages),
	eventRsvps: many(eventRsvps),
	scheduledNotifications: many(scheduledNotifications),
	deviceTokens: many(deviceTokens),
}));

export const staffRelations = relations(staff, ({many}) => ({
	dogs: many(dogs),
	reports: many(reports),
	bookings: many(bookings),
	pendingRequests: many(pendingRequests),
	cancelWindowSettings: many(cancelWindowSettings),
	threads: many(threads),
	notifications: many(notifications),
	messages: many(messages),
	bookingDogs: many(bookingDogs),
}));

export const vetsRelations = relations(vets, ({many}) => ({
	dogs: many(dogs),
}));

export const dogVaccinesRelations = relations(dogVaccines, ({one}) => ({
	dog: one(dogs, {
		fields: [dogVaccines.dogId],
		references: [dogs.id]
	}),
	requiredVaccine: one(requiredVaccines, {
		fields: [dogVaccines.requirementKey],
		references: [requiredVaccines.key]
	}),
}));

export const requiredVaccinesRelations = relations(requiredVaccines, ({many}) => ({
	dogVaccines: many(dogVaccines),
}));

export const dogMedicationsRelations = relations(dogMedications, ({one}) => ({
	dog: one(dogs, {
		fields: [dogMedications.dogId],
		references: [dogs.id]
	}),
}));

export const dogFeedingRelations = relations(dogFeeding, ({one}) => ({
	dog: one(dogs, {
		fields: [dogFeeding.dogId],
		references: [dogs.id]
	}),
}));

export const dogCompletedClassesRelations = relations(dogCompletedClasses, ({one}) => ({
	dog: one(dogs, {
		fields: [dogCompletedClasses.dogId],
		references: [dogs.id]
	}),
}));

export const classPrereqOptionsRelations = relations(classPrereqOptions, ({one}) => ({
	groupClass_classKey: one(groupClasses, {
		fields: [classPrereqOptions.classKey],
		references: [groupClasses.key],
		relationName: "classPrereqOptions_classKey_groupClasses_key"
	}),
	groupClass_prereqClassKey: one(groupClasses, {
		fields: [classPrereqOptions.prereqClassKey],
		references: [groupClasses.key],
		relationName: "classPrereqOptions_prereqClassKey_groupClasses_key"
	}),
}));

export const groupClassesRelations = relations(groupClasses, ({many}) => ({
	classPrereqOptions_classKey: many(classPrereqOptions, {
		relationName: "classPrereqOptions_classKey_groupClasses_key"
	}),
	classPrereqOptions_prereqClassKey: many(classPrereqOptions, {
		relationName: "classPrereqOptions_prereqClassKey_groupClasses_key"
	}),
	cohorts: many(cohorts),
}));

export const cohortsRelations = relations(cohorts, ({one, many}) => ({
	groupClass: one(groupClasses, {
		fields: [cohorts.classKey],
		references: [groupClasses.key]
	}),
	bookings: many(bookings),
	invoices: many(invoices),
}));

export const reportsRelations = relations(reports, ({one, many}) => ({
	dog: one(dogs, {
		fields: [reports.dogId],
		references: [dogs.id]
	}),
	staff: one(staff, {
		fields: [reports.trainerStaffId],
		references: [staff.id]
	}),
	mediaAssets: many(mediaAssets),
	bookings_reportId: many(bookings, {
		relationName: "bookings_reportId_reports_id"
	}),
	bookings_sessionReportId: many(bookings, {
		relationName: "bookings_sessionReportId_reports_id"
	}),
	scheduledNotifications: many(scheduledNotifications),
}));

export const mediaAssetsRelations = relations(mediaAssets, ({one}) => ({
	owner: one(owners, {
		fields: [mediaAssets.ownerId],
		references: [owners.id]
	}),
	dog: one(dogs, {
		fields: [mediaAssets.dogId],
		references: [dogs.id]
	}),
	report: one(reports, {
		fields: [mediaAssets.reportId],
		references: [reports.id]
	}),
}));

export const bookingsRelations = relations(bookings, ({one, many}) => ({
	owner: one(owners, {
		fields: [bookings.ownerId],
		references: [owners.id]
	}),
	dog: one(dogs, {
		fields: [bookings.leadDogId],
		references: [dogs.id]
	}),
	staff: one(staff, {
		fields: [bookings.trainerStaffId],
		references: [staff.id]
	}),
	cohort: one(cohorts, {
		fields: [bookings.cohortId],
		references: [cohorts.id]
	}),
	report_reportId: one(reports, {
		fields: [bookings.reportId],
		references: [reports.id],
		relationName: "bookings_reportId_reports_id"
	}),
	report_sessionReportId: one(reports, {
		fields: [bookings.sessionReportId],
		references: [reports.id],
		relationName: "bookings_sessionReportId_reports_id"
	}),
	afterSchoolOptins: many(afterSchoolOptins),
	pendingRequests: many(pendingRequests),
	creditLedgers: many(creditLedger),
	charges: many(charges),
	invoices: many(invoices),
	refunds: many(refunds),
	scheduledNotifications: many(scheduledNotifications),
	bookingDogs: many(bookingDogs),
}));

export const afterSchoolOptinsRelations = relations(afterSchoolOptins, ({one}) => ({
	dog: one(dogs, {
		fields: [afterSchoolOptins.dogId],
		references: [dogs.id]
	}),
	owner: one(owners, {
		fields: [afterSchoolOptins.ownerId],
		references: [owners.id]
	}),
	booking: one(bookings, {
		fields: [afterSchoolOptins.bookingId],
		references: [bookings.id]
	}),
}));

export const pendingRequestsRelations = relations(pendingRequests, ({one, many}) => ({
	owner: one(owners, {
		fields: [pendingRequests.ownerId],
		references: [owners.id]
	}),
	dog: one(dogs, {
		fields: [pendingRequests.leadDogId],
		references: [dogs.id]
	}),
	staff: one(staff, {
		fields: [pendingRequests.approvedByStaffId],
		references: [staff.id]
	}),
	booking: one(bookings, {
		fields: [pendingRequests.convertedBookingId],
		references: [bookings.id]
	}),
	invoices: many(invoices),
	pendingRequestDogs: many(pendingRequestDogs),
	pendingRequestPreferredDates: many(pendingRequestPreferredDates),
}));

export const cancelWindowSettingsRelations = relations(cancelWindowSettings, ({one}) => ({
	staff: one(staff, {
		fields: [cancelWindowSettings.updatedByStaffId],
		references: [staff.id]
	}),
}));

export const creditLedgerRelations = relations(creditLedger, ({one}) => ({
	dog: one(dogs, {
		fields: [creditLedger.dogId],
		references: [dogs.id]
	}),
	booking: one(bookings, {
		fields: [creditLedger.bookingId],
		references: [bookings.id]
	}),
	creditPackage: one(creditPackages, {
		fields: [creditLedger.packageId],
		references: [creditPackages.id]
	}),
	charge: one(charges, {
		fields: [creditLedger.chargeId],
		references: [charges.id]
	}),
}));

export const creditPackagesRelations = relations(creditPackages, ({many}) => ({
	creditLedgers: many(creditLedger),
}));

export const chargesRelations = relations(charges, ({one, many}) => ({
	creditLedgers: many(creditLedger),
	owner: one(owners, {
		fields: [charges.ownerId],
		references: [owners.id]
	}),
	booking: one(bookings, {
		fields: [charges.bookingId],
		references: [bookings.id]
	}),
	invoices: many(invoices),
	refunds: many(refunds),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({one, many}) => ({
	owner: one(owners, {
		fields: [paymentMethods.ownerId],
		references: [owners.id]
	}),
	invoices: many(invoices),
}));

export const stripeCustomersRelations = relations(stripeCustomers, ({one}) => ({
	owner: one(owners, {
		fields: [stripeCustomers.ownerId],
		references: [owners.id]
	}),
}));

export const invoicesRelations = relations(invoices, ({one}) => ({
	owner: one(owners, {
		fields: [invoices.ownerId],
		references: [owners.id]
	}),
	booking: one(bookings, {
		fields: [invoices.bookingId],
		references: [bookings.id]
	}),
	cohort: one(cohorts, {
		fields: [invoices.cohortId],
		references: [cohorts.id]
	}),
	pendingRequest: one(pendingRequests, {
		fields: [invoices.requestId],
		references: [pendingRequests.id]
	}),
	paymentMethod: one(paymentMethods, {
		fields: [invoices.paymentMethodId],
		references: [paymentMethods.id]
	}),
	charge: one(charges, {
		fields: [invoices.paidChargeId],
		references: [charges.id]
	}),
}));

export const membershipsRelations = relations(memberships, ({one}) => ({
	owner: one(owners, {
		fields: [memberships.ownerId],
		references: [owners.id]
	}),
	dog: one(dogs, {
		fields: [memberships.dogId],
		references: [dogs.id]
	}),
}));

export const agreementSignaturesRelations = relations(agreementSignatures, ({one}) => ({
	owner: one(owners, {
		fields: [agreementSignatures.ownerId],
		references: [owners.id]
	}),
	agreementDocument: one(agreementDocuments, {
		fields: [agreementSignatures.documentKey],
		references: [agreementDocuments.key]
	}),
}));

export const agreementDocumentsRelations = relations(agreementDocuments, ({many}) => ({
	agreementSignatures: many(agreementSignatures),
}));

export const refundsRelations = relations(refunds, ({one}) => ({
	owner: one(owners, {
		fields: [refunds.ownerId],
		references: [owners.id]
	}),
	charge: one(charges, {
		fields: [refunds.chargeId],
		references: [charges.id]
	}),
	booking: one(bookings, {
		fields: [refunds.bookingId],
		references: [bookings.id]
	}),
}));

export const idempotencyKeysRelations = relations(idempotencyKeys, ({one}) => ({
	owner: one(owners, {
		fields: [idempotencyKeys.ownerId],
		references: [owners.id]
	}),
}));

export const threadsRelations = relations(threads, ({one, many}) => ({
	owner: one(owners, {
		fields: [threads.ownerId],
		references: [owners.id]
	}),
	staff: one(staff, {
		fields: [threads.participantStaffId],
		references: [staff.id]
	}),
	messages: many(messages),
	threadDogs: many(threadDogs),
}));

export const notificationsRelations = relations(notifications, ({one, many}) => ({
	owner: one(owners, {
		fields: [notifications.ownerId],
		references: [owners.id]
	}),
	staff: one(staff, {
		fields: [notifications.senderStaffId],
		references: [staff.id]
	}),
	scheduledNotifications: many(scheduledNotifications),
	notificationDogs: many(notificationDogs),
}));

export const messagesRelations = relations(messages, ({one}) => ({
	thread: one(threads, {
		fields: [messages.threadId],
		references: [threads.id]
	}),
	owner: one(owners, {
		fields: [messages.senderOwnerId],
		references: [owners.id]
	}),
	staff: one(staff, {
		fields: [messages.senderStaffId],
		references: [staff.id]
	}),
}));

export const eventsRelations = relations(events, ({one, many}) => ({
	eventSery: one(eventSeries, {
		fields: [events.seriesId],
		references: [eventSeries.id]
	}),
	eventRsvps: many(eventRsvps),
}));

export const eventSeriesRelations = relations(eventSeries, ({many}) => ({
	events: many(events),
}));

export const eventRsvpsRelations = relations(eventRsvps, ({one, many}) => ({
	event: one(events, {
		fields: [eventRsvps.eventId],
		references: [events.id]
	}),
	owner: one(owners, {
		fields: [eventRsvps.ownerId],
		references: [owners.id]
	}),
	eventRsvpDogs: many(eventRsvpDogs),
}));

export const scheduledNotificationsRelations = relations(scheduledNotifications, ({one}) => ({
	owner: one(owners, {
		fields: [scheduledNotifications.ownerId],
		references: [owners.id]
	}),
	booking: one(bookings, {
		fields: [scheduledNotifications.bookingId],
		references: [bookings.id]
	}),
	report: one(reports, {
		fields: [scheduledNotifications.reportId],
		references: [reports.id]
	}),
	dog: one(dogs, {
		fields: [scheduledNotifications.dogId],
		references: [dogs.id]
	}),
	notification: one(notifications, {
		fields: [scheduledNotifications.emittedNotificationId],
		references: [notifications.id]
	}),
}));

export const deviceTokensRelations = relations(deviceTokens, ({one}) => ({
	owner: one(owners, {
		fields: [deviceTokens.ownerId],
		references: [owners.id]
	}),
}));

export const notificationDogsRelations = relations(notificationDogs, ({one}) => ({
	notification: one(notifications, {
		fields: [notificationDogs.notificationId],
		references: [notifications.id]
	}),
	dog: one(dogs, {
		fields: [notificationDogs.dogId],
		references: [dogs.id]
	}),
}));

export const threadDogsRelations = relations(threadDogs, ({one}) => ({
	thread: one(threads, {
		fields: [threadDogs.threadId],
		references: [threads.id]
	}),
	dog: one(dogs, {
		fields: [threadDogs.dogId],
		references: [dogs.id]
	}),
}));

export const eventRsvpDogsRelations = relations(eventRsvpDogs, ({one}) => ({
	eventRsvp: one(eventRsvps, {
		fields: [eventRsvpDogs.rsvpId],
		references: [eventRsvps.id]
	}),
	dog: one(dogs, {
		fields: [eventRsvpDogs.dogId],
		references: [dogs.id]
	}),
}));

export const pendingRequestDogsRelations = relations(pendingRequestDogs, ({one}) => ({
	pendingRequest: one(pendingRequests, {
		fields: [pendingRequestDogs.requestId],
		references: [pendingRequests.id]
	}),
	dog: one(dogs, {
		fields: [pendingRequestDogs.dogId],
		references: [dogs.id]
	}),
}));

export const pendingRequestPreferredDatesRelations = relations(pendingRequestPreferredDates, ({one}) => ({
	pendingRequest: one(pendingRequests, {
		fields: [pendingRequestPreferredDates.requestId],
		references: [pendingRequests.id]
	}),
}));

export const bookingDogsRelations = relations(bookingDogs, ({one}) => ({
	booking: one(bookings, {
		fields: [bookingDogs.bookingId],
		references: [bookings.id]
	}),
	dog: one(dogs, {
		fields: [bookingDogs.dogId],
		references: [dogs.id]
	}),
	staff: one(staff, {
		fields: [bookingDogs.checkedInByStaffId],
		references: [staff.id]
	}),
}));