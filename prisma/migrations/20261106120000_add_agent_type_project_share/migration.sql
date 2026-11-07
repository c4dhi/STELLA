-- Custom agents are private to their uploader until shared with a project.

-- CreateTable
CREATE TABLE "AgentTypeProjectShare" (
    "id" TEXT NOT NULL,
    "agentTypeId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentTypeProjectShare_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentTypeProjectShare_projectId_idx" ON "AgentTypeProjectShare"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTypeProjectShare_agentTypeId_projectId_key" ON "AgentTypeProjectShare"("agentTypeId", "projectId");

-- AddForeignKey
ALTER TABLE "AgentTypeProjectShare" ADD CONSTRAINT "AgentTypeProjectShare_agentTypeId_fkey" FOREIGN KEY ("agentTypeId") REFERENCES "AgentType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTypeProjectShare" ADD CONSTRAINT "AgentTypeProjectShare_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
