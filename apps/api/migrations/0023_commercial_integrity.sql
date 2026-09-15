CREATE TRIGGER quote_lines_service_tenant_scope
BEFORE INSERT ON quote_lines
WHEN NEW.service_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM quotes q JOIN services s ON s.id = NEW.service_id
  WHERE q.id = NEW.quote_id AND q.organisation_id = s.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'quote line service must share its organisation');
END;

CREATE TRIGGER quote_lines_require_draft_quote
BEFORE INSERT ON quote_lines
WHEN NOT EXISTS (
  SELECT 1 FROM quotes WHERE id = NEW.quote_id AND status = 'DRAFT'
)
BEGIN
  SELECT RAISE(ABORT, 'quote lines require a draft quote');
END;

CREATE TRIGGER services_financial_terms_immutable
BEFORE UPDATE OF organisation_id, unit_price_atomic, asset_code, asset_scale
ON services
BEGIN
  SELECT RAISE(ABORT, 'service financial terms are immutable');
END;
