-- An emoji and a description the owner chooses for each connector.
ALTER TABLE "Connector" ADD COLUMN "icon" TEXT;
ALTER TABLE "Connector" ADD COLUMN "description" TEXT;
