-- The booking's contact person can carry an email.
--
-- A travel agent's contact record already holds name, phone AND email, but the entry could only
-- store the first two — so the email the agency gave us was dropped at intake and the desk had
-- no address for the person it actually rings about the stay.
--
-- Optional everywhere: W4 still requires only name + phone before pre-arrival activation.
ALTER TABLE "entries" ADD COLUMN "contactPersonEmail" TEXT;
