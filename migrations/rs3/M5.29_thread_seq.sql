-- M5.29 (plan unit P45; wire 9.2.0, `MessageWire.seq` and `ThreadWire.last_seq`; design
-- messaging-live-v1 §4 M8.07, as A1.4 renumbers it and A2 FM3 folds M8.09 into it) — order and
-- ownership. In this order:
--   0. `lock_timeout` first (A2 ON2): queued behind a long transaction on `threads` or
--      `messages`, the step fails in 5 s and runs again, instead of stalling every send.
--   1. `threads.last_seq` (0 before a first message) and a nullable `messages.thread_seq`.
--   2. The permanent BEFORE INSERT trigger: `UPDATE threads SET last_seq = last_seq + 1 …
--      RETURNING` takes the thread's row lock at insert time, so concurrent sends serialize
--      and `seq` follows COMMIT order (W1, M1). It covers every insert site, `seed-dev.ts`, the
--      contract fixture and code from before this unit included, with no route remembering to.
--   3. The backfill: `row_number() OVER (PARTITION BY thread_id ORDER BY sent_at, id)` (an
--      expired message keeps its number), then each thread's `last_seq` is its max. Its audit
--      rows carry the runner's actor, `system:migrate-M5.29` (brief LR12): one per message and
--      one per thread that has messages.
--   4. NOT NULL (A2 FM3): the trigger fills `thread_seq` before the constraint is checked, so
--      code from before the unit still inserts. No rs4 step: rs4 and M5.31 are retired.
--   5. One number per thread, by unique index.
--   6. A thread's owner never changes (design §3 rule 3, made executed): an UPDATE that
--      changes `owner_id` raises. The publish choke point reads `owner_id` from the committed
--      row, so this is what keeps it true.
-- Both trigger functions are revoked from PUBLIC, `anon` and `authenticated` where they are
-- created. Rev.: drop both triggers and functions, the index, then the two columns.
SET LOCAL lock_timeout = '5s';

ALTER TABLE threads ADD COLUMN last_seq integer NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN thread_seq integer;

CREATE FUNCTION messages_assign_thread_seq() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE threads SET last_seq = last_seq + 1
   WHERE id = NEW.thread_id
  RETURNING last_seq INTO NEW.thread_seq;
  RETURN NEW;
END;
$$;
CREATE TRIGGER messages_assign_thread_seq BEFORE INSERT ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_assign_thread_seq();
REVOKE ALL ON FUNCTION messages_assign_thread_seq() FROM PUBLIC, anon, authenticated;

UPDATE messages m
   SET thread_seq = numbered.seq
  FROM (
    SELECT id, row_number() OVER (PARTITION BY thread_id ORDER BY sent_at, id) AS seq
      FROM messages
  ) numbered
 WHERE m.id = numbered.id;

UPDATE threads t
   SET last_seq = numbered.max_seq
  FROM (SELECT thread_id, max(thread_seq) AS max_seq FROM messages GROUP BY thread_id) numbered
 WHERE t.id = numbered.thread_id;

ALTER TABLE messages ALTER COLUMN thread_seq SET NOT NULL;
CREATE UNIQUE INDEX messages_thread_seq_uidx ON messages (thread_id, thread_seq);

CREATE FUNCTION threads_owner_id_immutable() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
    RAISE EXCEPTION 'threads.owner_id never changes: thread % keeps its owner', OLD.id
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER threads_owner_id_immutable BEFORE UPDATE OF owner_id ON threads
  FOR EACH ROW EXECUTE FUNCTION threads_owner_id_immutable();
REVOKE ALL ON FUNCTION threads_owner_id_immutable() FROM PUBLIC, anon, authenticated;
