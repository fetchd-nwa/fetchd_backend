-- M2.01 (S05, ACCT-U04) — an owner's name, phone and home campus may be empty.
-- design §4 LG2 (design.md:6162), §2.2 ACCT-U04 (design.md:2244).
-- Rev.: yes while no row holds a NULL in these columns. Empty prod: 0 rows.
--
-- An imported owner may arrive with any of the three empty (MIG-57), and the
-- signup-field map (acct.signup_field_requirement_map) decides which of them an
-- owner must fill: PATCH /me refuses blanking a mandatory one (profile_incomplete)
-- and stores an emptied one as NULL, never ''. `email` stays NOT NULL: it is the
-- login identity, and the map fixes it as mandatory.
--
-- No table is created, so the step needs no per-table REVOKE, and the group's
-- closing REVOKE (DECISIONS 86) has nothing of this step's to repeat.
ALTER TABLE owners
  ALTER COLUMN name DROP NOT NULL,
  ALTER COLUMN phone DROP NOT NULL,
  ALTER COLUMN location DROP NOT NULL;
