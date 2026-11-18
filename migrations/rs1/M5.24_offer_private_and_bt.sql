-- M5.24 (P49, plan unit; wire 9.0.0; build DECISIONS 393) — private lessons and Board &
-- Train are offered, and their tiles shown, at both campuses. Boarding is untouched: it
-- opens per family only on Shanthi's switch. design request-services-v1 §5.1. Rows only;
-- `schema.sql`'s seed says the same (`rs1-steps.test.ts` holds the two equal). Rev.: set
-- both back to `offered: false, client_visible: false`.
--
-- Her words: "i want private and board and train to be active" (11-14 19:32), on her
-- condition that the portal switch is not flipped until the new flow exists: this is the
-- last step of P49, its own commit, landed after the gates are green and the reviews
-- close. Each service document keeps its `name` and `description`; only the two flags
-- move.
UPDATE day_program_settings
   SET offerings = jsonb_set(
         jsonb_set(
           offerings,
           '{private-lesson}',
           (offerings -> 'private-lesson') || '{"offered": true, "client_visible": true}'::jsonb
         ),
         '{board-and-train}',
         (offerings -> 'board-and-train') || '{"offered": true, "client_visible": true}'::jsonb
       )
 WHERE location IN ('fayetteville', 'bentonville');
