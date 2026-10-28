#!/usr/bin/env ts-node
/**
 * Migration script to fix Room.serverUrl in the database
 *
 * This script updates all Room records that have localhost URLs
 * to use the Kubernetes internal service name instead.
 *
 * Usage:
 *   npm run fix-room-urls
 *   or
 *   ts-node scripts/fix-room-urls.ts
 */

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg'

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });

const OLD_URL = 'ws://localhost:7880';
const NEW_URL = 'ws://livekit:7880';

async function main() {
  console.log('🔧 Fixing Room URLs in database...\n');

  // Find all rooms with localhost URLs
  const roomsToFix = await prisma.room.findMany({
    where: {
      serverUrl: OLD_URL,
    },
    include: {
      session: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  console.log(`Found ${roomsToFix.length} rooms with localhost URLs\n`);

  if (roomsToFix.length === 0) {
    console.log('✅ No rooms need updating. All rooms are already using correct URLs.\n');
    return;
  }

  // Show what will be updated
  console.log('Rooms to update:');
  roomsToFix.forEach((room) => {
    console.log(`  - ${room.livekitRoomName} (Session: ${room.session?.name || 'N/A'})`);
  });

  console.log(`\nUpdating from: ${OLD_URL}`);
  console.log(`          to: ${NEW_URL}\n`);

  // Perform the update
  const result = await prisma.room.updateMany({
    where: {
      serverUrl: OLD_URL,
    },
    data: {
      serverUrl: NEW_URL,
    },
  });

  console.log(`✅ Successfully updated ${result.count} room(s)\n`);

  // Verify the update
  const remainingOldUrls = await prisma.room.count({
    where: {
      serverUrl: OLD_URL,
    },
  });

  if (remainingOldUrls > 0) {
    console.log(`⚠️  Warning: ${remainingOldUrls} room(s) still have old URLs\n`);
  } else {
    console.log('✨ All rooms are now using the correct LiveKit URL!\n');
  }
}

main()
  .catch((error) => {
    console.error('❌ Error updating room URLs:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
