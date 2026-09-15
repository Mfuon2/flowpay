DROP TRIGGER quote_lines_require_draft_quote;

CREATE TRIGGER quote_lines_require_draft_quote
BEFORE INSERT ON quote_lines
WHEN NOT EXISTS (SELECT 1 FROM quote_lines WHERE id = NEW.id)
  AND NOT EXISTS (
    SELECT 1 FROM quotes WHERE id = NEW.quote_id AND status = 'DRAFT'
  )
BEGIN
  SELECT RAISE(ABORT, 'quote lines require a draft quote');
END;
