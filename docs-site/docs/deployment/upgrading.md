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
git describe --tags
```

**Check Node on the host.** Since 1.3.0 the deploy runs database migrations with Prisma 7 on the host, and Prisma 7 needs Node 20.19+, 22.12+ or 24+:

```bash
node --version
```

**Take a backup.** Stella must be running for this, because the backup reads the live database:

```bash
./scripts/start-k8s.sh --backup
```

Choose **Export**. The wizard asks whether to include metrics and logs (not needed to get a working system back) and for a passphrase, and writes `stella-backup-<timestamp>.zip.enc` to the current directory. Releases before 1.3.0 ask whether to encrypt at all: say yes. This is the same backup for a local instance and a production server. Before you go on:

- Check the file exists and is not empty: `ls -lh stella-backup-*.zip.enc`.
- Keep the passphrase somewhere other than next to the file. Without it, the backup cannot be restored.
- Copy the file off the machine if you are upgrading a server.

[Backup & Restore](./backup-restore.md) explains what the bundle contains and how encryption works.

## The upgrade

Fetch the release and check out its tag, for example `v1.3.0`:

```bash
git fetch --tags
git checkout v1.3.0
```

Then redeploy:

```bash
./scripts/start-k8s.sh --restart -d
```

Use `--rebuild` instead of `--restart` only if the changelog says images must be rebuilt from scratch; it takes much longer. `-d` runs the deploy in the background and returns when it is done.

The deploy applies the release's database migrations by itself before the backend starts. You do not run them by hand.

### Check that it worked

All pods should be `Running` and ready:

```bash
kubectl -n ai-agents get pods
```

The backend should report the new version:

```bash
kubectl -n ai-agents exec deploy/session-management-server -- \
  node -e "fetch('http://localhost:3000/version').then(r=>r.json()).then(v=>console.log(v.version))"
```

The version starts with the release number, for example `1.3.0-…`. Then open the web interface, sign in, and start one short session with a voice. If the voice is silent, see [Troubleshooting](#troubleshooting).

## Manual steps per version

Run the steps of every version you pass, oldest first. A version not listed here needs none.

### 1.4.0

Filled in with the release.

### 1.3.0

**Turn plan prompts into personas.** In 1.3.0 an agent's identity (name, prompt, voice) moved from the plan to a [persona](../agents/personas.md). A one-time script carries each existing plan's own prompt and voice over, so your plans keep their personality. Run it after the upgrade, with the new version running.

The script talks to the database directly and reads its address from the environment variable `DATABASE_URL`. Open a connection to the database and set the variable from the deployment's own secret:

```bash
kubectl -n ai-agents port-forward svc/postgres 5433:5432 &
export DATABASE_URL=$(kubectl -n ai-agents get secret stella-ai-secrets \
  -o jsonpath='{.data.database-url}' | base64 -d | sed 's/@postgres:5432/@localhost:5433/')
```

Install the repository's Node packages if you have not yet (`npm ci`). Then do a dry run. It changes nothing and prints, for each plan, the persona it would create:

```bash
npx ts-node scripts/migrations/extract-plan-personas.ts
```

Read the output. Add `--show-prompts` to see the start of each prompt as well. If it looks right, run it again with `--apply`:

```bash
npx ts-node scripts/migrations/extract-plan-personas.ts --apply
```

It is safe to run again; a second dry run then has nothing left to do. Afterwards, stop the connection with `kill %1`.

Saved agent configurations that set a custom persona in the old configurator slot are not carried over. Recreate those as personas under **Settings → Personas**.

## Rolling back

Database migrations only go forward. To go back, you return to the previous release **and** restore the backup you took before the upgrade. Everything recorded after the backup is lost: sessions, messages, plans and settings changed since then.

1. Check out the release you came from, for example:

   ```bash
   git checkout v1.2.0
   ```

2. Redeploy it with an empty database. `--reset-db` deletes the database; the older release cannot run on the upgraded one:

   ```bash
   ./scripts/start-k8s.sh --reset-db -d
   ```

3. Restore the backup:

   ```bash
   ./scripts/start-k8s.sh --backup
   ```

   Choose **Restore**, give the path of the `stella-backup-<timestamp>.zip.enc` you made before the upgrade, confirm, and enter its passphrase. The restore refuses a bundle whose database version does not match the running release, which is why step 2 comes first.

4. Check it worked as in [Check that it worked](#check-that-it-worked); the version now shows the release you came from.

## Troubleshooting

**The deploy stops at the database migration with `P3009`** ("found failed migrations"). An earlier migration attempt failed halfway. The deploy prints the name of the failed migration and the commands to resolve it. Read which case applies before running them: marking a migration as applied when it was not leaves the database inconsistent. If in doubt, roll back.

**Prisma refuses to start** with a message about the Node version. Update Node on the host (see [Before you upgrade](#before-you-upgrade)) and run the deploy again.

**The voice is silent after the upgrade.** Check which voice model the voice service loaded:

```bash
kubectl -n ai-agents logs deploy/tts-service -c tts-service | grep "Provider:"
```

`Provider: none` means the model failed to load; the lines above it say why.

**A pod stays in `ImagePullBackOff`.** The new image is not in the cluster. On a server this usually means the disk holding the images is nearly full. Check with `df -h`, free space, and run the deploy again.
