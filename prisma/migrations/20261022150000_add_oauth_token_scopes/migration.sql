-- AlterTable
ALTER TABLE "OAuthToken" ADD COLUMN     "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[];
