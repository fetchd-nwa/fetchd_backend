-- M1.18 (S01, STAFF-U22) — every settings edit keeps the value it replaced.
-- design §4 LG1 (design.md:6146), §2.1 STAFF-U22. audit_capture()'s row_pk
-- learns the settings tables' keys, in this order: the key/scope arm
-- (payment_settings) BEFORE the bare key arm; the existing arms through date;
-- then category (cancel_window_settings), field_key (intake_field_settings) and
-- location, where a NULL location is the '<global>' row of a two-tier table
-- (credit_expiry_settings, day_program_settings, evaluation_settings). Every arm
-- reads to_jsonb(OLD). Then the AFTER UPDATE OR DELETE trigger on the four
-- existing settings tables and every table M1.01–M1.16 creates.
--
-- A trigger copies nothing when it is attached: a pre-image reaches audit_log
-- only for a row an UPDATE or DELETE touches after this step. The 22 rows of the
-- four existing tables are audited from here on; nothing is rewritten.
CREATE OR REPLACE FUNCTION audit_capture() RETURNS trigger AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_pk, op, before, actor)
  VALUES (
    TG_TABLE_NAME,
    COALESCE((to_jsonb(OLD) ->> 'id'),
             CASE WHEN to_jsonb(OLD) ? 'scope'
                  THEN (to_jsonb(OLD) ->> 'key') || '/' || (to_jsonb(OLD) ->> 'scope') END,
             (to_jsonb(OLD) ->> 'key'),
             (to_jsonb(OLD) ->> 'dog_id'),
             (to_jsonb(OLD) ->> 'booking_id'),
             (to_jsonb(OLD) ->> 'request_id'),
             (to_jsonb(OLD) ->> 'thread_id'),
             (to_jsonb(OLD) ->> 'rsvp_id'),
             (to_jsonb(OLD) ->> 'notification_id'),
             (to_jsonb(OLD) ->> 'date'),
             (to_jsonb(OLD) ->> 'category'),
             (to_jsonb(OLD) ->> 'field_key'),
             CASE WHEN to_jsonb(OLD) ? 'location'
                  THEN COALESCE(to_jsonb(OLD) ->> 'location', '<global>') END),
    TG_OP,
    to_jsonb(OLD),
    current_setting('app.actor', true)
  );
  RETURN NULL;  -- AFTER trigger; return value ignored
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cancel_window_settings_audit AFTER UPDATE OR DELETE ON cancel_window_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER credit_expiry_settings_audit AFTER UPDATE OR DELETE ON credit_expiry_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER intake_field_settings_audit AFTER UPDATE OR DELETE ON intake_field_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER dog_descriptors_audit AFTER UPDATE OR DELETE ON dog_descriptors
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER account_settings_audit AFTER UPDATE OR DELETE ON account_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER alumni_settings_audit AFTER UPDATE OR DELETE ON alumni_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER cash_settings_audit AFTER UPDATE OR DELETE ON cash_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER credit_settings_audit AFTER UPDATE OR DELETE ON credit_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER day_program_settings_audit AFTER UPDATE OR DELETE ON day_program_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER dog_gate_settings_audit AFTER UPDATE OR DELETE ON dog_gate_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER evaluation_settings_audit AFTER UPDATE OR DELETE ON evaluation_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER migration_settings_audit AFTER UPDATE OR DELETE ON migration_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER messaging_settings_audit AFTER UPDATE OR DELETE ON messaging_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER notification_settings_audit AFTER UPDATE OR DELETE ON notification_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER payment_settings_audit AFTER UPDATE OR DELETE ON payment_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER reports_settings_audit AFTER UPDATE OR DELETE ON reports_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
CREATE TRIGGER vaccine_settings_audit AFTER UPDATE OR DELETE ON vaccine_settings
  FOR EACH ROW EXECUTE FUNCTION audit_capture();
