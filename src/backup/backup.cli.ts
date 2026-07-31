/**
 * In-pod backup CLI (#378 / system relocation).
 *
 * Runs INSIDE the backend pod, e.g.:
 *   kubectl exec deploy/session-management-server -- \
 *     node dist/src/backup/backup.cli.js export --out /tmp/data.zip
 *
 * It runs here (not on the host) because only the pod can reach BOTH the
 * database and the agent-package volume. It deals only with the DATA bundle
 * (DB + packages); the deployment .env config and at-rest encryption are layered
 * on by the wizard export/restore scripts that wrap this command.
 *
 * Output: a single JSON line on stdout so the calling shell can parse the result.
 */
import { NestFactory } from '@nestjs/core'
import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import * as fs from 'fs/promises'
import { PrismaModule } from '../prisma/prisma.module'
import { StorageModule } from '../storage/storage.module'
import { BackupModule } from './backup.module'
import { BackupService } from './backup.service'

// Minimal context: just the backup engine and the globals it relies on. Avoids
// booting the full app (HTTP/gRPC/LiveKit) for a one-off command.
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    StorageModule,
    BackupModule,
  ],
})
class BackupCliModule {}

interface CliArgs {
  out?: string
  in?: string
  includeMetrics: boolean
  confirm: boolean
  allowKeyMismatch: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    includeMetrics: false,
    confirm: false,
    allowKeyMismatch: false,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--out':
        args.out = argv[++i]
        break
      case '--in':
        args.in = argv[++i]
        break
      case '--include-metrics':
        args.includeMetrics = true
        break
      case '--confirm':
        args.confirm = true
        break
      case '--allow-key-mismatch':
        args.allowKeyMismatch = true
        break
    }
  }
  return args
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2)
  const args = parseArgs(rest)

  const app = await NestFactory.createApplicationContext(BackupCliModule, {
    logger: ['error', 'warn'],
  })
  try {
    const backup = app.get(BackupService)

    if (command === 'export') {
      if (!args.out) throw new Error('export requires --out <path>')
      const result = await backup.export({ includeMetrics: args.includeMetrics })
      await fs.copyFile(result.bundlePath, args.out)
      await result.cleanup()
      process.stdout.write(
        JSON.stringify({
          ok: true,
          filename: result.filename,
          bytes: result.byteLength,
        }) + '\n',
      )
    } else if (command === 'import') {
      if (!args.in) throw new Error('import requires --in <path>')
      const report = await backup.import({
        bundlePath: args.in,
        confirmOverwrite: args.confirm,
        allowKeyMismatch: args.allowKeyMismatch,
        // No authenticated user in a pod; the wrapper script passes the operator
        // identity so the audit trail (#380) is not just "cli".
        actor: { type: 'cli', label: process.env.STELLA_AUDIT_ACTOR || null },
      })
      process.stdout.write(JSON.stringify({ ok: true, report }) + '\n')
    } else {
      throw new Error(
        'usage: backup.cli <export --out PATH [--include-metrics] | ' +
          'import --in PATH --confirm [--allow-key-mismatch]>',
      )
    }
  } finally {
    await app.close()
  }
}

main().catch((err) => {
  process.stderr.write(`${err?.message ?? err}\n`)
  process.exit(1)
})
