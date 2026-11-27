-- #213: an optional message every public-link participant sees on screen
-- before the session, carried onto each participant's invitation.
ALTER TABLE "Project" ADD COLUMN "publicWelcomeMessage" TEXT;
