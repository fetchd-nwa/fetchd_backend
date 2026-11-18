-- M5.22 (P49, plan unit; wire 9.0.0 A12) — Board & Train leaves the evaluation gate's
-- trigger floor. design request-services-v1 §2.2 A12, §4.5; Allison s21
-- (`SIGNOFF.md:124`): a dog with no passed evaluation may book an evaluation, a private
-- lesson, a Board & Train or a group class. Rev.: restore the four-category predicate.
--
-- The trigger, `lib/bookingGatePreCheck.ts`'s EVAL_GATED_CATEGORIES and the request
-- boundary in `routes/requests.ts` move together. The body below is `schema.sql`'s
-- function exactly (the fingerprint hashes `pg_get_functiondef`).
CREATE OR REPLACE FUNCTION assert_dog_evaluation_passed() RETURNS trigger AS $$
DECLARE
  lead_is_staff_dog boolean;
BEGIN
  -- 'evaluation' category is the dog's path TO passing — never gated.
  IF NEW.category = 'evaluation' THEN
    RETURN NEW;
  END IF;
  -- Only the three gated categories run the check; PL, B&T (M5.22, P49: Allison
  -- s21, a dog with no passed evaluation may book a Board & Train), group-class
  -- and any future free-text category fall through.
  IF NEW.category NOT IN ('day-school','day-care','boarding') THEN
    RETURN NEW;
  END IF;
  SELECT (d.staff_owner_id IS NOT NULL) INTO lead_is_staff_dog
  FROM dogs d WHERE d.id = NEW.lead_dog_id;
  IF COALESCE(lead_is_staff_dog, false) THEN
    RETURN NEW;                               -- staff dogs exempt (consistent)
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM dogs d
     WHERE d.id = NEW.lead_dog_id AND d.evaluation_status = 'passed'
  ) THEN
    RAISE EXCEPTION
      'evaluation gate: lead dog % must have evaluation_status = passed (category %)',
      NEW.lead_dog_id, NEW.category USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
