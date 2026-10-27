---
sidebar_position: 9
title: "⬆️ Upgrading Stella"
---

# Upgrading Stella

How to go from one Stella release to the next, on the machine you deploy from with `./scripts/start-k8s.sh`. This works the same for a local instance and a production server. The commands assume the default namespace `ai-agents`; on a K3s server, write `sudo k3s kubectl` where this page says `kubectl`.

In short:

1. Back up.
2. Check out the new release and redeploy.
3. Run the manual steps for every version you pass.
4. Check that it worked.

If it goes wrong, [roll back](#rolling-back) to the backup.

## Before you upgrade

**Read the changelog** section of every version between the one you run and the one you want, especially its "Upgrade notes". Find the version you run now with:

```bash
git describe --tags --match 'v*'
```

**Check Node on the host.** Since 1.3.0 the deploy runs database migrations with Prisma 7 on the host, and Prisma 7 needs Node 20.19+, 22.12+ or 24+:

```bash
node --version
```

**Take a backup.** Stella must be running for this, because the backup reads the live database:

```bash
./scripts/start-k8s.sh --backup
```

Choose **Export**. The wizard asks whether to include metrics and logs (not needed to get a working system back) and for a passphrase, and writes `stella-backup-<timestamp>.zip.enc` into the Stella directory, next to `scripts/`. Releases before 1.3.0 ask whether to encrypt at all: say yes. This is the same backup for a local instance and a production server. Before you go on:

- Check the file exists and is not empty: `ls -lh stella-backup-*.zip.enc`.
- Keep the passphrase somewhere other than next to the file. Without it, the backup cannot be restored.
- Copy the file off the machine if you are upgrading a server.

[Backup & Restore](./backup-restore.md) explains what the bundle contains and how encryption works.

## The upgrade

Fetch the release, check out its tag, for example `v1.3.0`, and install that release's Node packages:

```bash
git fetch --tags
git checkout v1.3.0
npm ci
```

Do not skip `npm ci`. The deploy runs the database migrations on this machine with these packages, and with the previous release's packages it stops at "Database migrations" (see [Troubleshooting](#troubleshooting)).

Then redeploy:

```bash
./scripts/start-k8s.sh --restart -d
```

Use `--rebuild` instead of `--restart` only if the changelog says images must be rebuilt from scratch; it takes much longer. `-d` runs the deploy in the background and returns when it is done.

The deploy applies the release's database migrations by itself before the backend starts. You do not run them by hand.

### Check that it worked

All pods should be `Running` and ready, and started just now (the `AGE` column):

```bash
kubectl -n ai-agents get pods
```

Then open the web interface and sign in. **Settings** shows the version at the bottom of its sidebar, for example `STELLA v1.3.0`. Start one short session with a voice. If the voice is silent, see [Troubleshooting](#troubleshooting).

## Manual steps per version

Run the steps of every version you pass, oldest first. A version not listed here needs none.

### 1.5.0

None. The deploy applies three new database migrations on its own (access tokens and the MCP audit log, MCP sign-in, token scopes), so back up first as described above.

MCP is off after the upgrade. To let AI assistants connect, a system admin switches it on in **Settings → Platform Defaults**. Sign-in from Claude and ChatGPT builds on `PUBLIC_API_URL` and `PUBLIC_FRONTEND_URL`, so check that both are the addresses the outside world reaches.

### 1.4.0

None. The deploy applies the one new database migration (the `PlatformSetting` table) on its own, so back up first as described above.

Check two things in your configuration, without running anything:

- **Default model.** A deployment or configuration that names no model now runs `gpt-5.4-mini`. Set the model explicitly if your study must keep the old one.
- **Language settings.** `switch_threshold` and `debounce` are no longer read. If a configuration set them, set `text_bar`, `decay` and `switch_score` instead (defaults 0.85, 0.5 and 1.5).

### 1.3.0

**Turn plan prompts into personas.** In 1.3.0 an agent's identity (name, prompt, voice) moved from the plan to a [persona](../agents/personas.md). A one-time script carries each existing plan's and public project's own prompt and voice over to a persona, so they keep their personality. Run it after the upgrade, with the new version running.

The script talks to the database directly and reads its address from the environment variable `DATABASE_URL`. Open a connection to the database and set the variable from the deployment's own secret:

```bash
kubectl -n ai-agents port-forward svc/postgres 5433:5432 &
export DATABASE_URL=$(kubectl -n ai-agents get secret stella-ai-secrets \
  -o jsonpath='{.data.database-url}' | base64 -d | sed 's/@postgres:5432/@localhost:5433/')
```

The script needs the database client generated on this machine (the deploy only generates it inside its images):

```bash
npx prisma generate
```

Then do a dry run. It changes nothing and prints, for each plan, the persona it would create:

```bash
node --import ./scripts/register-ts-node-esm.mjs scripts/migrations/extract-plan-personas.ts
```

Read the output. Add `--show-prompts` to see each prompt as well. If it looks right, run it again with `--apply`:

```bash
node --import ./scripts/register-ts-node-esm.mjs scripts/migrations/extract-plan-personas.ts --apply
```

It prints how many personas it created and how many plans it linked. The comment at the top of the script says `npx ts-node`; that does not work since 1.3.0, so use the command above.

It is safe to run again; a second dry run then has nothing left to do. Afterwards, stop the connection with `kill %1`.

Saved agent configurations that set a custom persona in the old configurator slot are not carried over. Recreate those as personas under **Settings → Personas**.

## Rolling back

Database migrations only go forward. To go back, you return to the previous release **and** restore the backup you took before the upgrade. Everything recorded after the backup is lost: sessions, messages, plans and settings changed since then.

1. Check out the release you came from and install its packages, for example:

   ```bash
   git checkout v1.2.0
   npm ci
   ```

2. Scale everything down, the database included. While the database runs, step 3 waits forever for its volume to be deleted:

   ```bash
   kubectl -n ai-agents scale deploy --all --replicas=0
   ```

3. Redeploy with an empty database. `--reset-db` deletes the database, since the older release cannot run on the upgraded one. It also deletes the stored voice and speech models, so they download again on the next start, which takes a while:

   ```bash
   ./scripts/start-k8s.sh --reset-db -d
   ```

   If it stops at "Database migrations" with `Script exited with code 1`, the new, empty database was not ready yet. Run `./scripts/start-k8s.sh -d` once more.

4. Restore the backup:

   ```bash
   ./scripts/start-k8s.sh --backup
   ```

   Choose **Restore**, give the path of the `stella-backup-<timestamp>.zip.enc` you made before the upgrade, type `overwrite` to confirm, and enter its passphrase. It ends with a table of row counts per table and `Restore complete`. The restore refuses a bundle whose database version does not match the running release, which is why step 3 comes first.

5. Check it worked as in [Check that it worked](#check-that-it-worked); Settings now shows the release you came from.

## Troubleshooting

**The deploy stops at "Database migrations".** Since 1.4.0 the deploy prints the migration's own error, retries up to four times when the database has only just started (a first deploy, or after `--reset-db`), and closes its database connection when it fails. The most common remaining cause: the Node packages are still the previous release's. Run `npm ci` and deploy again.

Up to 1.3.0 the deploy printed only `Script exited with code 1`, a database that had only just started also failed it (deploy again), and the failed attempt could leave its connection open, so the next one said `Port 5433 already in use`. Close it with `pkill -f "port-forward svc/postgres 5433"` and deploy again. To see the actual error, run the migration yourself with the connection from [1.3.0](#130) open: `npx prisma migrate deploy`.

**The deploy stops at the database migration with `P3009`** ("found failed migrations"). An earlier migration attempt failed halfway. The deploy prints the name of the failed migration and the commands to resolve it. Read which case applies before running them: marking a migration as applied when it was not leaves the database inconsistent. If in doubt, roll back.

**Prisma refuses to start** with a message about the Node version. Update Node on the host (see [Before you upgrade](#before-you-upgrade)) and run the deploy again.

**The voice is silent after the upgrade.** Check which voice model the voice service loaded:

```bash
kubectl -n ai-agents logs deploy/tts-service -c tts-service | grep "Provider:"
```

`Provider: none` means the model failed to load; the lines above it say why.

**A pod stays in `ImagePullBackOff`.** The new image is not in the cluster. On a server this usually means the disk holding the images is nearly full. Check with `df -h`, free space, and run the deploy again.
