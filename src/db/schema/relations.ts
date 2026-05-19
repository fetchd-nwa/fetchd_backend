import { relations } from "drizzle-orm/relations";
import { owners, dogs, vets, staff, dogVaccines, requiredVaccines, dogMedications, dogFeeding, dogCompletedClasses, groupClasses, cohorts, reports, mediaAssets, bookings, afterSchoolOptins, pendingRequests, creditLedger, charges, creditPackages, stripeCustomers, paymentMethods, invoices, memberships, refunds, agreementDocuments, agreementSignatures, idempotencyKeys, threads, scheduledNotifications, notifications, messages, eventSeries, events, eventRsvps, deviceTokens, notificationDogs, threadDogs, eventRsvpDogs, pendingRequestDogs, pendingRequestPreferredDates, bookingDogs } from "./schema.js";

export const dogsRelations = relations(dogs, ({one, many}) => ({
	owner: one(owners, {
		fields: [dogs.ownerId],
		references: [owners.id]
	}),
	vet: one(vets, {
		fields: [dogs.primaryVetId],
		references: [vets.id]
	}),
	staff: one(staff, {
		fields: [dogs.staffOwnerId],
		references: [staff.id]
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
	stripeCustomers: many(stripeCustomers),
	paymentMethods: many(paymentMethods),
	charges: many(charges),
	invoices: many(invoices),
	memberships: many(memberships),
	refunds: many(refunds),
	agreementSignatures: many(agreementSignatures),
	idempotencyKeys: many(idempotencyKeys),
	threads: many(threads),
	scheduledNotifications: many(scheduledNotifications),
	messages: many(messages),
	notifications: many(notifications),
	eventRsvps: many(eventRsvps),
	deviceTokens: many(deviceTokens),
}));

export const vetsRelations = relations(vets, ({many}) => ({
	dogs: many(dogs),
}));

export const staffRelations = relations(staff, ({many}) => ({
	dogs: many(dogs),
	reports: many(reports),
	bookings: many(bookings),
	pendingRequests: many(pendingRequests),
	threads: many(threads),
	messages: many(messages),
	notifications: many(notifications),
	bookingDogs: many(bookingDogs),
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

export const groupClassesRelations = relations(groupClasses, ({one, many}) => ({
	groupClass: one(groupClasses, {
		fields: [groupClasses.prereqClassKey],
		references: [groupClasses.key],
		relationName: "groupClasses_prereqClassKey_groupClasses_key"
	}),
	groupClasses: many(groupClasses, {
		relationName: "groupClasses_prereqClassKey_groupClasses_key"
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
	dog: one(dogs, {
		fields: [mediaAssets.dogId],
		references: [dogs.id]
	}),
	owner: one(owners, {
		fields: [mediaAssets.ownerId],
		references: [owners.id]
	}),
	report: one(reports, {
		fields: [mediaAssets.reportId],
		references: [reports.id]
	}),
}));

export const bookingsRelations = relations(bookings, ({one, many}) => ({
	cohort: one(cohorts, {
		fields: [bookings.cohortId],
		references: [cohorts.id]
	}),
	dog: one(dogs, {
		fields: [bookings.leadDogId],
		references: [dogs.id]
	}),
	owner: one(owners, {
		fields: [bookings.ownerId],
		references: [owners.id]
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
	staff: one(staff, {
		fields: [bookings.trainerStaffId],
		references: [staff.id]
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
	booking: one(bookings, {
		fields: [afterSchoolOptins.bookingId],
		references: [bookings.id]
	}),
	dog: one(dogs, {
		fields: [afterSchoolOptins.dogId],
		references: [dogs.id]
	}),
	owner: one(owners, {
		fields: [afterSchoolOptins.ownerId],
		references: [owners.id]
	}),
}));

export const pendingRequestsRelations = relations(pendingRequests, ({one, many}) => ({
	staff: one(staff, {
		fields: [pendingRequests.approvedByStaffId],
		references: [staff.id]
	}),
	booking: one(bookings, {
		fields: [pendingRequests.convertedBookingId],
		references: [bookings.id]
	}),
	dog: one(dogs, {
		fields: [pendingRequests.leadDogId],
		references: [dogs.id]
	}),
	owner: one(owners, {
		fields: [pendingRequests.ownerId],
		references: [owners.id]
	}),
	invoices: many(invoices),
	pendingRequestDogs: many(pendingRequestDogs),
	pendingRequestPreferredDates: many(pendingRequestPreferredDates),
}));

export const creditLedgerRelations = relations(creditLedger, ({one}) => ({
	booking: one(bookings, {
		fields: [creditLedger.bookingId],
		references: [bookings.id]
	}),
	charge: one(charges, {
		fields: [creditLedger.chargeId],
		references: [charges.id]
	}),
	dog: one(dogs, {
		fields: [creditLedger.dogId],
		references: [dogs.id]
	}),
	creditPackage: one(creditPackages, {
		fields: [creditLedger.packageKey],
		references: [creditPackages.key]
	}),
}));

export const chargesRelations = relations(charges, ({one, many}) => ({
	creditLedgers: many(creditLedger),
	booking: one(bookings, {
		fields: [charges.bookingId],
		references: [bookings.id]
	}),
	owner: one(owners, {
		fields: [charges.ownerId],
		references: [owners.id]
	}),
	invoices: many(invoices),
	refunds: many(refunds),
}));

export const creditPackagesRelations = relations(creditPackages, ({many}) => ({
	creditLedgers: many(creditLedger),
}));

export const stripeCustomersRelations = relations(stripeCustomers, ({one}) => ({
	owner: one(owners, {
		fields: [stripeCustomers.ownerId],
		references: [owners.id]
	}),
}));

export const paymentMethodsRelations = relations(paymentMethods, ({one, many}) => ({
	owner: one(owners, {
		fields: [paymentMethods.ownerId],
		references: [owners.id]
	}),
	invoices: many(invoices),
}));

export const invoicesRelations = relations(invoices, ({one}) => ({
	booking: one(bookings, {
		fields: [invoices.bookingId],
		references: [bookings.id]
	}),
	cohort: one(cohorts, {
		fields: [invoices.cohortId],
		references: [cohorts.id]
	}),
	owner: one(owners, {
		fields: [invoices.ownerId],
		references: [owners.id]
	}),
	charge: one(charges, {
		fields: [invoices.paidChargeId],
		references: [charges.id]
	}),
	paymentMethod: one(paymentMethods, {
		fields: [invoices.paymentMethodId],
		references: [paymentMethods.id]
	}),
	pendingRequest: one(pendingRequests, {
		fields: [invoices.requestId],
		references: [pendingRequests.id]
	}),
}));

export const membershipsRelations = relations(memberships, ({one}) => ({
	dog: one(dogs, {
		fields: [memberships.dogId],
		references: [dogs.id]
	}),
	owner: one(owners, {
		fields: [memberships.ownerId],
		references: [owners.id]
	}),
}));

export const refundsRelations = relations(refunds, ({one}) => ({
	booking: one(bookings, {
		fields: [refunds.bookingId],
		references: [bookings.id]
	}),
	charge: one(charges, {
		fields: [refunds.chargeId],
		references: [charges.id]
	}),
	owner: one(owners, {
		fields: [refunds.ownerId],
		references: [owners.id]
	}),
}));

export const agreementSignaturesRelations = relations(agreementSignatures, ({one}) => ({
	agreementDocument: one(agreementDocuments, {
		fields: [agreementSignatures.documentKey],
		references: [agreementDocuments.key]
	}),
	owner: one(owners, {
		fields: [agreementSignatures.ownerId],
		references: [owners.id]
	}),
}));

export const agreementDocumentsRelations = relations(agreementDocuments, ({many}) => ({
	agreementSignatures: many(agreementSignatures),
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

export const scheduledNotificationsRelations = relations(scheduledNotifications, ({one}) => ({
	booking: one(bookings, {
		fields: [scheduledNotifications.bookingId],
		references: [bookings.id]
	}),
	dog: one(dogs, {
		fields: [scheduledNotifications.dogId],
		references: [dogs.id]
	}),
	notification: one(notifications, {
		fields: [scheduledNotifications.emittedNotificationId],
		references: [notifications.id]
	}),
	owner: one(owners, {
		fields: [scheduledNotifications.ownerId],
		references: [owners.id]
	}),
	report: one(reports, {
		fields: [scheduledNotifications.reportId],
		references: [reports.id]
	}),
}));

export const notificationsRelations = relations(notifications, ({one, many}) => ({
	scheduledNotifications: many(scheduledNotifications),
	owner: one(owners, {
		fields: [notifications.ownerId],
		references: [owners.id]
	}),
	staff: one(staff, {
		fields: [notifications.senderStaffId],
		references: [staff.id]
	}),
	notificationDogs: many(notificationDogs),
}));

export const messagesRelations = relations(messages, ({one}) => ({
	owner: one(owners, {
		fields: [messages.senderOwnerId],
		references: [owners.id]
	}),
	staff: one(staff, {
		fields: [messages.senderStaffId],
		references: [staff.id]
	}),
	thread: one(threads, {
		fields: [messages.threadId],
		references: [threads.id]
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

export const deviceTokensRelations = relations(deviceTokens, ({one}) => ({
	owner: one(owners, {
		fields: [deviceTokens.ownerId],
		references: [owners.id]
	}),
}));

export const notificationDogsRelations = relations(notificationDogs, ({one}) => ({
	dog: one(dogs, {
		fields: [notificationDogs.dogId],
		references: [dogs.id]
	}),
	notification: one(notifications, {
		fields: [notificationDogs.notificationId],
		references: [notifications.id]
	}),
}));

export const threadDogsRelations = relations(threadDogs, ({one}) => ({
	dog: one(dogs, {
		fields: [threadDogs.dogId],
		references: [dogs.id]
	}),
	thread: one(threads, {
		fields: [threadDogs.threadId],
		references: [threads.id]
	}),
}));

export const eventRsvpDogsRelations = relations(eventRsvpDogs, ({one}) => ({
	dog: one(dogs, {
		fields: [eventRsvpDogs.dogId],
		references: [dogs.id]
	}),
	eventRsvp: one(eventRsvps, {
		fields: [eventRsvpDogs.rsvpId],
		references: [eventRsvps.id]
	}),
}));

export const pendingRequestDogsRelations = relations(pendingRequestDogs, ({one}) => ({
	dog: one(dogs, {
		fields: [pendingRequestDogs.dogId],
		references: [dogs.id]
	}),
	pendingRequest: one(pendingRequests, {
		fields: [pendingRequestDogs.requestId],
		references: [pendingRequests.id]
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
	staff: one(staff, {
		fields: [bookingDogs.checkedInByStaffId],
		references: [staff.id]
	}),
	dog: one(dogs, {
		fields: [bookingDogs.dogId],
		references: [dogs.id]
	}),
}));