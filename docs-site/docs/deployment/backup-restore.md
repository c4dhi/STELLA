---
sidebar_position: 5
title: Backup & Restore
description: Full-system export/import for disaster recovery and machine-to-machine migration
---

# Backup & Restore

STELLA can export an **entire deployment** to a single bundle and restore it onto
another machine — an exact clone with secrets intact. Use this for
disaster-recovery backups and for moving a deployment to new hardware.

A bundle contains:

- **The database** — every application table (users, projects, sessions,
  messages, agent types, env-var templates, …), exported as JSON.
- **The agent packages** — every uploaded custom-agent zip from
  `AGENT_STORAGE_PATH`.
- **The deployment config** — the wizard's `.env` (secrets + settings:
  `ENV_VAR_ENCRYPTION_KEY`, `JWT_SECRET`, API keys, LiveKit, TTS, …), so the
  clone comes up identical.
- **A manifest** — metadata that makes a bundle safe to move between machines
  (see [What the manifest guards](#what-the-manifest-guards)).

Excluded by design (rebuilt on the target, not data): agent Docker images,
TTS/STT model weights, and live LiveKit rooms.

The backup engine is pure Node + Postgres — no database-specific tooling such as
`pg_dump` or `zip` is needed anywhere. Table fidelity (timestamps, big integers)
is handled by Postgres itself, so a restore reproduces the source exactly. (The
scripts still use the host's normal deploy toolchain — `node` and `kubectl`; see
[Prerequisites](#prerequisites).)

**Schema-driven — extends itself.** The set of tables a bundle covers is derived
from the live Prisma schema, not a hand-maintained list. Add a model to
`schema.prisma` and it is automatically included in every backup and restore —
there is no list to update and no way to silently leave a new table out. The only
hand-maintained input is a small opt-out list of high-volume observability tables
(`METRICS_MODELS`) that are excluded by default; forgetting to add a new table
there is harmless (it just exports as normal data).

**Bounded memory at any size.** Every stage streams: tables are paginated into
fixed-size chunk files (never one giant JSON string), the zip is read/written one
entry at a time, and encryption streams through the cipher. A bundle the size of
the whole deployment moves through constant RAM — the practical ceiling is disk,
not memory. Export reads under a single consistent snapshot; the destructive part
of import runs in **one transaction**, so a failure mid-restore rolls back instead
of leaving a half-wiped database.

:::danger A bundle is a full credential
Because the bundle embeds the deployment config, it contains **every secret** —
password hashes, `ENV_VAR_ENCRYPTION_KEY`, API keys. A leaked bundle is a total
compromise: anyone who can read the file owns the deployment.
:::

## Encryption

**Export encrypts by default** (AES-256-GCM with a scrypt-derived key — pure
Node, no external tools). An encrypted bundle is named `….zip.enc`, and restore
detects encryption and asks for the passphrase.

Producing an unencrypted bundle takes **two** explicit flags —
`--no-encrypt --allow-plaintext-config`. One flag alone is refused. This is
deliberate: a single mistyped or copy-pasted flag should never be enough to write
every secret to disk in the clear. The refusal is enforced both in the export
script and in the helper that actually writes the file, so it cannot be lost to a
scripting mistake.

### Passphrase custody

The passphrase is the one secret never written into the bundle, which makes it
the only thing standing between a stolen file and full compromise.

- **Store it somewhere other than the bundle** — a password manager, not the
  same directory, drive, or email thread. A passphrase carried alongside the file
  it protects provides no protection at all.
- **Send it over a different channel than the bundle.** If the bundle goes by
  file transfer, send the passphrase by a separate medium.
- **Make it long.** It is the entire key strength; a short passphrase is
  brute-forceable offline once someone holds the file. Export enforces a
  **12-character minimum** and will refuse anything shorter. (Restore has no such
  rule, so bundles made before it existed stay restorable.)
- **There is no recovery.** Lose the passphrase and the backup is permanently
  unreadable — by design. Confirm you can decrypt a bundle *before* you rely on
  it for disaster recovery.
- **Rotate after relocation.** Once a move is complete, treat the passphrase as
  spent: delete the transferred bundle and use a fresh passphrase for the next
  export.

### Secure transport

- Copy bundles over an authenticated, encrypted channel (`scp`/`rsync` over SSH).
  Never email, chat, or upload one to shared storage — even encrypted, it invites
  an offline attack on the passphrase.
- Verify the file arrived intact before restoring (compare a `sha256sum` taken on
  both ends).
- Delete the bundle from every intermediate machine once the restore is verified.
  Copies left on a laptop or jump host are the most common way one of these leaks.

### Unattended use

Set `BACKUP_PASSPHRASE` in the environment and both export and restore skip the
interactive prompt. Without it, a non-interactive run (CI, cron, a pipe) stops
with an explicit message rather than failing silently on an unanswerable prompt.
Prefer a secret store or a shell that does not record history — an exported
passphrase can otherwise end up in shell history or process listings.

### Files on disk

Every file the backup path writes — bundles, the decrypted staging copy, the
extracted `.env` — is created **mode 0600**, and plaintext intermediates are
staged in owner-only (0700) temporary directories rather than a shared `/tmp`.
On a multi-user deploy host this is what stops another local account reading the
whole credential during the export or restore window.

Restore also snapshots the config it is about to replace, as
`.env.<env>.pre-restore.<timestamp>` in the project directory. **That file is a
complete plaintext credential.** It is created 0600 and is gitignored, but it
persists until you remove it — see the runbook's cleanup step.

## Who can do this

- **Export** runs only as a **wizard/deploy script** (`scripts/backup-export.sh`),
  because gathering the data, the agent-package volume, and the deployment config
  together is a deploy-layer operation. There is no UI export.
- **Restore** is a **wizard/deploy script** (`scripts/backup-restore.sh`) for a
  full relocation (config + data), or a **data-only** import from the
  **Admin Dashboard** (`/settings/admin`, SystemAdmin only) when the deployment
  is already configured.

Export is gated by **cluster access** (you need `kubectl` against the deployment)
rather than by a SystemAdmin login. That is the tighter of the two: anyone with
cluster access can already read `stella-ai-secrets` directly, so an admin-login
export would add a way to download every credential without adding any control.
It is also the only workable place for it — the deployment `.env` lives on the
deploy host, outside the pod, so an API-driven export could not produce a
secret-carrying bundle at all.

## Prerequisites

The export/restore scripts run on the **deploy host** (the machine you run
`start-k8s.sh` from) and need its standard toolchain — **`node`, `npx`, and
`kubectl`**. These are already required to deploy STELLA, and the scripts check
for them up front, failing with the exact install command if any is missing.

Export is a **logical** backup, so it needs a **running system**:

- **Postgres must be running** — the database is read live (a stopped database
  is just opaque files and cannot be exported).
- **The backend pod must be running** — the export engine runs inside it (the
  only place that can see both the database and the agent-package volume).

`backup-export.sh` verifies both before doing anything and tells you which part
is down if not. A fully wound-down deployment cannot be exported — bring it up
(or scale Postgres + backend up) first.

## Guided wizard (easiest)

For an interactive flow that walks you through both directions — choosing
encryption, metrics, and the bundle to restore — run:

```bash
./scripts/start-k8s.sh --backup
```

It prompts for the high-level choices and then runs the same export/restore
scripts below (which still handle passphrase entry and confirmations). The
direct script invocations remain available for automation/CI.

The wizard **always encrypts** — it deliberately does not offer an unencrypted
option, since a single keystroke should not be able to produce a plaintext
credential. If you genuinely need one, call `backup-export.sh` with both flags.

## Export

```bash
# Prompts for a passphrase, writes ./stella-backup-<timestamp>.zip.enc
./scripts/backup-export.sh [--production|--local]

# Include the high-volume metrics/observability tables (larger bundle)
./scripts/backup-export.sh --include-metrics

# Unattended (CI/automation) — no prompt
BACKUP_PASSPHRASE='…' ./scripts/backup-export.sh

# Unencrypted, secrets in the clear — both flags required, use only if you
# understand that the result is a plaintext credential
./scripts/backup-export.sh --no-encrypt --allow-plaintext-config
```

Under the hood the script execs the in-pod backup CLI to produce the data bundle
(only the backend pod can see both the database and the package volume), copies
it out, embeds the deployment `.env`, and optionally encrypts the result.

## Restore — full relocation (script)

:::warning Restore overwrites everything
This **permanently replaces ALL data and config** in the target namespace. It
cannot be undone.
:::

```bash
./scripts/backup-restore.sh --in stella-backup-<timestamp>.zip [--production|--local]
```

The script: backs up the current `.env`, installs the restored config, recreates
the `stella-ai-secrets` secret and restarts the backend (so the restored
`ENV_VAR_ENCRYPTION_KEY` and keys take effect), then imports the database and
agent packages in-pod — overwriting all data. Intended for a fresh target
already brought up with [`start-k8s.sh`](./kubernetes.md).

## Restore — data only (admin UI)

When the target is already configured with the matching `ENV_VAR_ENCRYPTION_KEY`,
an admin can restore just the **data** from the dashboard:

1. **Settings → Admin Dashboard → Restore from backup**.
2. **Import backup…**, choose the bundle, enter the passphrase if it is encrypted.
3. Confirm **Overwrite everything?**.

This path restores data + packages but **not** deployment config — so the target
must already have the correct encryption key, or the key-fingerprint guard will
stop the import.

:::warning Restoring a core-only bundle onto a *live* system also clears its metrics
Restore empties the bundle's tables with `TRUNCATE … CASCADE`. When the bundle
excludes metrics (the default), truncating core tables such as `User`/`Session`/
`Room` cascades into the metrics/log tables that reference them — so those tables
are emptied even though they are not restored. This is expected and harmless when
cloning onto a **fresh** target, but on a **live** system it drops the target's
existing metrics/logs. The import report lists exactly which tables this affected.
Export with `--include-metrics` if you need them carried over.
:::

## What the manifest guards

Before any data is written, import checks the bundle's manifest against the
target server:

| Guard | Behaviour on mismatch |
|---|---|
| **Format version** | Hard abort — the bundle layout isn't understood. |
| **Migration head** | Hard abort — the bundle's schema doesn't match the target's migrations. Deploy the matching app version first, then retry. |
| **Encryption-key fingerprint** | Hard abort — restored secrets would not decrypt. |

The full restore script recreates the secret from the bundle's config *before*
importing, so the encryption-key guard passes automatically. For the data-only
UI path, the target must already run the original key. A `--allow-key-mismatch`
override exists (data-only "I'll re-enter secrets" restores) but is intentionally
not surfaced in the dashboard.

## Relocating to a new machine — runbook

1. **On the source**, run `./scripts/backup-export.sh` (encrypted by default) and
   copy the `….zip.enc` to the target over SSH. Carry the passphrase by a
   separate channel — see [Passphrase custody](#passphrase-custody).
2. **On the target**, bring up the stack with
   [`start-k8s.sh`](./kubernetes.md) and the **same app version** (so the
   migration head matches).
3. **Restore**: `./scripts/backup-restore.sh --in <bundle>` — it applies the
   config, recreates secrets, restarts the backend, and imports the data.
4. **Verify**: login works, projects/sessions/messages are present, agent
   packages resolve, and env-var-template secrets decrypt.
5. **Clean up**: delete the bundle from the target and from any machine it
   passed through, remove the `.env.*.pre-restore.*` snapshot the restore left in
   the project directory (a full plaintext credential), and rotate the passphrase
   before the next export.

   ```bash
   rm -f .env.*.pre-restore.*        # once you have confirmed the restore worked
   ```

:::warning The encryption key must travel with the data
`ENV_VAR_ENCRYPTION_KEY` is deployment config, not database content. Every
`EnvVarTemplate` secret and every `AgentInstance.manualEnvVarsEncrypted` value is
AES-256-GCM ciphertext that **only that key** can open. Restore the data onto a
machine with a different key and those secrets are permanently unreadable — the
agents come up without their API keys.

The script path handles this for you: the bundle carries the key inside the
embedded config, and restore installs it *before* importing. The guard exists for
the cases where it does not — the data-only UI import, or a hand-assembled
restore. If you ever move the database by other means (`pg_dump`, a volume
snapshot, a replica), you must carry `ENV_VAR_ENCRYPTION_KEY` across yourself.
:::

:::note
This restores persistent data and config and keeps encrypted secrets usable. It
is a disaster-recovery / relocation capability, **not** a zero-downtime cutover —
in-flight voice sessions are not migrated.
:::
