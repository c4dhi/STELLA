-- #170: an invitation an automatic session close revoked remembers its status
-- from before, so reopening the session can give it back. Existing rows stay
-- NULL: invitations already revoked before this release are not restored.
ALTER TABLE "Invitation" ADD COLUMN "statusBeforeAutoRevoke" "InvitationStatus";
