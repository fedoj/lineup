-- Player IDs now read "AvaG001": the first name, the last initial of the
-- parent who signed the child up, and a number counting up from 001 for that
-- name ("Ava001" without a parent's last name). IDs given in the first format
-- ("Ava G. 482") are cleared and given again the next time the roster is read.
UPDATE player SET public_id = NULL, public_org_id = NULL WHERE public_id LIKE '% %';
