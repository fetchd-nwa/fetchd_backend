-- M5.01 (S29, DAY-U29, DAY-U33) — the check-in log: six kinds, one append-only row per board verb.
-- design §4 LG5 (design.md:6221), §2.3:2354-2370. Rev.: yes (the type with it). Empty prod: creates.
--
-- The board's verbs append here and never edit: a dog's state is folded from her live
-- events in `seq` order (`src/lib/checkinFold.ts`), and a mistake is corrected by an
-- `undo` naming the event it removes. All six kinds land now, the type being created
-- whole; the three settling kinds' verbs are S30's (P20 pass 2). The row trigger
-- refuses UPDATE and DELETE unless a cascade from `booking_dogs` reaches it
-- (`pg_trigger_depth() > 1`), so a hard delete of a booking or a dog still passes; the
-- statement trigger refuses TRUNCATE. Revoked as it is created (DECISIONS 71).
CREATE TYPE checkin_event_kind AS ENUM ('check-in', 'check-out', 'undo', 'turn-away', 'sent-home', 'no-show');

CREATE TABLE checkin_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                 bigint GENERATED ALWAYS AS IDENTITY,
  booking_id          uuid NOT NULL,
  dog_id              uuid NOT NULL,
  kind                checkin_event_kind NOT NULL,
  at                  timestamptz NOT NULL,
  by_staff_id         uuid NOT NULL REFERENCES staff(id),
  undoes_event_id     uuid REFERENCES checkin_events(id),
  training_completed  boolean,
  reissue_credit      boolean,
  note                text,
  last_seen_moved     boolean NOT NULL DEFAULT false,
  last_seen_prior     date,
  created_at          timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (booking_id, dog_id) REFERENCES booking_dogs (booking_id, dog_id) ON DELETE CASCADE
);
CREATE INDEX checkin_events_share_seq_idx ON checkin_events (booking_id, dog_id, seq);
CREATE INDEX checkin_events_dog_idx ON checkin_events (dog_id);
REVOKE ALL ON checkin_events FROM anon, authenticated;

CREATE FUNCTION checkin_events_append_only() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'checkin_events is append-only: TRUNCATE is refused'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF pg_trigger_depth() > 1 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'checkin_events is append-only: % of event % is refused; correct it with an undo', TG_OP, OLD.id
    USING ERRCODE = 'restrict_violation';
END;
$$;
CREATE TRIGGER checkin_events_append_only_row BEFORE UPDATE OR DELETE ON checkin_events
  FOR EACH ROW EXECUTE FUNCTION checkin_events_append_only();
CREATE TRIGGER checkin_events_append_only_truncate BEFORE TRUNCATE ON checkin_events
  FOR EACH STATEMENT EXECUTE FUNCTION checkin_events_append_only();
REVOKE ALL ON FUNCTION checkin_events_append_only() FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE checkin_events IS 'The append-only check-in log: one row per board verb on one dog''s share of one session (M5.01). A dog''s state is folded from her live events in seq order; an undo names the event it removes. Never edited or deleted, except by a cascade from booking_dogs.';
