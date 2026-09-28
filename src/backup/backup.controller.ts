import {
  BadRequestException,
  Controller,
  Headers,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
  Logger,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { diskStorage } from 'multer'
import { tmpdir } from 'os'
import { randomBytes } from 'crypto'
import { SystemAdminGuard } from '../auth/guards/system-admin.guard'
import { CurrentUser } from '../common/decorators/current-user.decorator'
import { BackupService, BackupImportReport } from './backup.service'

/** The fields of the JWT user this controller needs for the audit trail. */
interface AdminUser {
  userId?: string
  email?: string
}

/**
 * Full-system backup import endpoint (#378). SystemAdmin-only.
 *
 * Export is intentionally NOT exposed over HTTP — it runs only via the wizard
 * export script (scripts/backup-export.sh → the in-pod backup CLI), which also
 * folds in deployment config and handles encryption. Import stays here so an
 * admin can restore a data bundle from the dashboard.
 */
@Controller('admin/backup')
@UseGuards(SystemAdminGuard)
export class BackupController {
  private readonly logger = new Logger(BackupController.name)

  constructor(private readonly backup: BackupService) {}

  /**
   * POST /admin/backup/import?confirmOverwrite=true[&allowKeyMismatch=true]
   * Header X-Backup-Passphrase: <passphrase> (only if the bundle is encrypted)
   *
   * Accepts a bundle upload and restores it, OVERWRITING all existing data. The
   * upload streams to a temp path on disk, and the whole restore pipeline
   * (decrypt, unzip, per-table insert) is bounded-memory — it processes the
   * bundle one entry/chunk at a time rather than loading it whole — so the
   * effective ceiling is disk, not RAM. `confirmOverwrite=true` is required —
   * the service refuses otherwise, mirroring the UI's overwrite confirmation.
   */
  @Post('import')
  @UseInterceptors(
    FileInterceptor('file', {
      storage: diskStorage({
        destination: tmpdir(),
        filename: (_req, _file, cb) =>
          cb(null, `stella-import-${randomBytes(8).toString('hex')}.zip`),
      }),
      // 20 GB ceiling — a backstop, not an expected size. The streamed pipeline
      // keeps memory flat regardless of bundle size.
      limits: { fileSize: 20 * 1024 * 1024 * 1024 },
    }),
  )
  async import(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Query('confirmOverwrite') confirmOverwrite: string | undefined,
    @Query('allowKeyMismatch') allowKeyMismatch: string | undefined,
    @Headers('x-backup-passphrase') passphrase: string | undefined,
    @CurrentUser() user: AdminUser | undefined,
  ): Promise<BackupImportReport> {
    if (!file) {
      throw new BadRequestException('No backup bundle uploaded')
    }
    // This endpoint needs only a SystemAdmin token — no cluster access — and it
    // wipes the deployment, so the acting user is carried through to the audit
    // trail (#380). Previously the log line below recorded the size and nothing
    // about who.
    this.logger.warn(
      `Backup import requested by ${user?.email ?? 'unknown'} ` +
        `(${file.size} bytes) — overwriting deployment.`,
    )
    return this.backup.import({
      bundlePath: file.path,
      confirmOverwrite: confirmOverwrite === 'true',
      allowKeyMismatch: allowKeyMismatch === 'true',
      passphrase: passphrase || undefined,
      actor: {
        type: 'system-admin',
        id: user?.userId ?? null,
        label: user?.email ?? null,
      },
    })
  }
}
