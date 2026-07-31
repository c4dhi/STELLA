import { Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import { AuditService } from './audit.service'
import {
  NEVER_RESTORE_MODELS,
  allTableNames,
  neverRestoreTableNames,
  tablesForExport,
  tablesForImport,
} from './manifest'

/**
 * Import audit trail (#380).
 *
 * Backup import is reachable over HTTP by any SystemAdmin with no cluster
 * access, and it truncates and replaces the entire deployment. These tests pin
 * the two properties that make the resulting record trustworthy:
 *
 *  1. An import cannot erase it (the never-restore set), and
 *  2. writing it can never break the operation it records.
 */
describe('audit trail', () => {
  describe('never-restore set', () => {
    it('keeps AuditEvent out of everything an import writes', () => {
      const bundleTables = allTableNames() // a bundle carrying every table

      const importable = tablesForImport(bundleTables)

      // tablesForImport feeds truncate, restore AND verification, so one
      // exclusion covers all three: never emptied, never overwritten, never
      // reported as a count mismatch.
      expect(bundleTables).toContain('AuditEvent')
      expect(importable).not.toContain('AuditEvent')
    })

    it('still EXPORTS the audit log, so a bundle carries the evidence', () => {
      // Excluded from restore is not the same as excluded from the bundle.
      expect(tablesForExport(false)).toContain('AuditEvent')
      expect(tablesForExport(true)).toContain('AuditEvent')
    })

    it('resolves the never-restore models against the live schema', () => {
      // Guards against the list drifting from the schema (e.g. a rename).
      expect(neverRestoreTableNames()).toEqual([...NEVER_RESTORE_MODELS])
    })

    it('leaves every other table restorable', () => {
      const importable = tablesForImport(allTableNames())
      const expected = allTableNames().filter((t) => t !== 'AuditEvent')
      expect(importable).toEqual(expected)
    })
  })

  describe('recording', () => {
    function serviceWith(create: jest.Mock): AuditService {
      return new AuditService({
        auditEvent: { create },
      } as unknown as PrismaService)
    }

    it('records who, what and the outcome', async () => {
      const create = jest.fn().mockResolvedValue({})
      await serviceWith(create).record(
        'backup.import',
        'success',
        { type: 'system-admin', id: 'u-1', label: 'admin@example.com' },
        { tableCount: 12, keyStatus: 'match' },
      )

      expect(create).toHaveBeenCalledTimes(1)
      const { data } = create.mock.calls[0][0]
      expect(data).toMatchObject({
        action: 'backup.import',
        outcome: 'success',
        actorType: 'system-admin',
        actorId: 'u-1',
        actorLabel: 'admin@example.com',
      })
      expect(data.detail).toMatchObject({ tableCount: 12, keyStatus: 'match' })
    })

    it('records the CLI actor with a null user id', async () => {
      const create = jest.fn().mockResolvedValue({})
      await serviceWith(create).record('backup.import', 'success', {
        type: 'cli',
        label: 'ops@deploy-host',
      })

      const { data } = create.mock.calls[0][0]
      expect(data.actorType).toBe('cli')
      expect(data.actorId).toBeNull()
      expect(data.actorLabel).toBe('ops@deploy-host')
    })

    it('never throws when the audit write fails', async () => {
      // Losing the record of a restore is bad; turning a completed restore into
      // a reported failure is worse. The write must not propagate.
      const create = jest.fn().mockRejectedValue(new Error('db is gone'))
      const errors: string[] = []
      const spy = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation((...args: unknown[]) => {
          errors.push(args.map((a) => String(a)).join(' '))
        })

      await expect(
        serviceWith(create).record('backup.import', 'success', { type: 'cli' }),
      ).resolves.toBeUndefined()

      // Silent loss would be worse than the failure itself.
      expect(errors.join('\n')).toMatch(/failed to write audit event/i)
      spy.mockRestore()
    })
  })
})
