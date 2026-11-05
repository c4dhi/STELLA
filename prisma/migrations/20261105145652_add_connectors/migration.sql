-- CreateEnum
CREATE TYPE "ConnectorKind" AS ENUM ('MCP');

-- CreateEnum
CREATE TYPE "ConnectorAuthType" AS ENUM ('BEARER', 'NONE');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('UNTESTED', 'OK', 'ERROR');

-- AlterTable
ALTER TABLE "AgentInstance" ADD COLUMN     "connectorBindings" JSONB,
ADD COLUMN     "connectorTokenHash" TEXT,
ADD COLUMN     "deployedByUserId" TEXT;

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL DEFAULT 'MCP',
    "url" TEXT NOT NULL,
    "authType" "ConnectorAuthType" NOT NULL DEFAULT 'BEARER',
    "credentialEncrypted" TEXT,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'UNTESTED',
    "lastError" TEXT,
    "lastCheckedAt" TIMESTAMP(3),
    "toolsSnapshot" JSONB,
    "serverInfo" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorProjectShare" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorProjectShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorAuditLog" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT,
    "userId" TEXT NOT NULL,
    "agentInstanceId" TEXT,
    "sessionId" TEXT,
    "operation" TEXT NOT NULL,
    "tool" TEXT,
    "argsSummary" JSONB,
    "success" BOOLEAN NOT NULL,
    "errorCode" TEXT,
    "durationMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Connector_userId_idx" ON "Connector"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_userId_handle_key" ON "Connector"("userId", "handle");

-- CreateIndex
CREATE INDEX "ConnectorProjectShare_projectId_idx" ON "ConnectorProjectShare"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectorProjectShare_connectorId_projectId_key" ON "ConnectorProjectShare"("connectorId", "projectId");

-- CreateIndex
CREATE INDEX "ConnectorAuditLog_connectorId_createdAt_idx" ON "ConnectorAuditLog"("connectorId", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectorAuditLog_userId_createdAt_idx" ON "ConnectorAuditLog"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectorAuditLog_createdAt_idx" ON "ConnectorAuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorProjectShare" ADD CONSTRAINT "ConnectorProjectShare_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorProjectShare" ADD CONSTRAINT "ConnectorProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorAuditLog" ADD CONSTRAINT "ConnectorAuditLog_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE SET NULL ON UPDATE CASCADE;
