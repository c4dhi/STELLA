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

Fetch the release, check out its tag, for example `v2.2.0`, and install that release's Node packages:

```bash
git fetch --tags
git checkout v2.2.0
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

Then open the web interface and sign in. **Settings** shows the version at the bottom of its sidebar, for example `STELLA v2.2.0`. Start one short session with a voice. If the voice is silent, see [Troubleshooting](#troubleshooting).

## Manual steps per version

Run the steps of every version you pass, oldest first. A version not listed here needs none.

### 2.2.0

The deploy applies one new database migration by itself, which adds a column for a public project's welcome message. Back up first, as described above.

After the upgrade:

- **Restart every running agent** from its session, so that it runs the new image. A running agent keeps the image it started with.
- **Check for outdated Pipeline Configurations.** Saved configurations are now checked against the verdict rules the agent declares. A configuration that uses a reaction or rule field the agent doesn't declare is marked outdated, and it can't be deployed until you fix it in the Pipeline Configurator and save it again. On their default configurations, STELLA V2 and Jev decide every turn exactly as before.
- **Medical and legal are safety experts now**, in STELLA V2 and in Jev. A saved configuration that sets `enabled: false` on one of them no longer turns it off. To turn one off, use the Pipeline Configurator: it asks for a confirmation and records who did it and when.
- **The arbitration Tone Map setting is empty by default.** It now only overrides the tone set on an expert's verdicts. A configuration that set its own values keeps them.
- **To pick up Agent SDK 0.12.0, rebuild uploaded agents.** 0.12.0 keeps text typed while speech services load, and it shows and speaks text sent from `on_ready()`. Agents keep working without a rebuild. Agent SDK 0.12.0 is on PyPI before this release reaches production.
- **The ELIAS-Interviewer agent is no longer in this repository.** It now lives in a repository of its own. An installation that has already uploaded it keeps it.

### 2.1.0

The deploy applies two new database migrations on its own (a column on invitations, so a session that reopens can give back the invitations its automatic close revoked, and a new inbox message type for failed agent builds), so back up first as described above. It also creates one new secret on its own, `stella-internal-key`, which the message recorder uses for its monitoring calls; there is nothing to set by hand.

After the upgrade:

- **Restart every running STELLA Jev agent** from its session, so it runs the new image. An agent that is already running keeps the image it started with.
- **Check for outdated Pipeline Configurations.** When the agent types are seeded, every saved configuration is checked against what its agent declares. A key the agent doesn't declare is dropped. A value that no longer fits (a model not in the list, a number out of range) marks the configuration outdated, and it can't be deployed until the value is fixed and the configuration saved again in the Pipeline Configurator.
- **Rebuild uploaded agents to get Agent SDK 0.11.0** (the wait for speech services after a restart, settings read from `agent.yaml`, `{{capabilities}}`). They keep working without a rebuild. Agent SDK 0.11.0 is on PyPI before this release reaches production. `BaseTool.guidance` is gone, so an agent that set it puts that text in its prompts instead.
- **The orphaned agent pod check starts log-only.** It logs what it would remove every 10 minutes. Once the log looks right, set `AGENT_RECONCILER_MODE=delete` in the deploy environment and redeploy to let it act (see [Environment variables](../architecture/environment-variables.md)).
- **Check configurations that override an expert's prompt.** An expert now gets exactly its configured prompt, and nothing appends the conversation or tool instructions any more. An overridden prompt without `{{history_N}}` or `{{user_message}}` needs them added. An overridden `task_extraction` or `companion_router` prompt needs the tool instructions its new default includes. In the SDK, `BaseTool.guidance` is gone, so a tool's usage text belongs in the prompt that uses it.
- **Check STELLA Jev configurations that changed an expert.** Jev now decides from the expert configuration, so a changed prompt or verdict description in a Jev expert changes what Jev decides. The default `ask_threshold` drops from 0.45 to 0.3; a configuration that set its own value keeps it.
- **The capabilities expert is off in configurations saved before 2.1.0**, production Grace's included. Switch it on in the Pipeline Configurator's Expert Pool where you want it.

### 2.0.1

The deploy applies one new database migration on its own (whether a project or a session closes once everyone has left, and when a session was kept open), so back up first as described above. The migration sets existing private projects to keep their sessions open and existing public projects to keep closing them.

After the upgrade:

- **Restart every running STELLA Jev agent** (or any built-in agent in a long session) from its session, so it runs the image with the memory fix. An agent that is already running keeps the image it started with.
- **Rebuild uploaded agents to get the memory fix.** They keep working without a rebuild, but only an image built with Agent SDK 0.10.1 has the fix. Open **Settings → Agent Library** and build each one again.

### 2.0.0

The deploy applies seven new database migrations on its own (connectors, connector icons and descriptions, the agent manifest, the agent's SDK version, sharing uploaded agents with projects with a backfill, and a column marking which configuration templates have been checked), so back up first as described above.

After the upgrade:

- **Rebuild every uploaded agent once.** STELLA now records which Agent SDK an image contains and refuses to deploy one whose SDK it doesn't know, so an agent uploaded before 2.0.0 can't be deployed until it is rebuilt. For each one, open **Settings → Agent Library** and build it again; with **Review uploaded agents** on, an admin approves it again too. Built-in agents are rebuilt by the deploy. Uploaded agents need Agent SDK 0.10.0 or newer (see [Agent validation](./agent-validation.md#sdk-versions)).
- **Check the built-in agents' required env vars.** A deploy that is missing one is now refused up front with a message that names it, instead of starting an agent that fails. STELLA V2 and STELLA Light need `OPENAI_API_KEY`; STELLA Jev needs `OPENAI_API_KEY` and `TYPESAFE_API_KEY`.
- **"Review uploaded agents" is on** (Settings → Platform Defaults), so an admin approves each upload before anyone can deploy it. Uploads keep their owner and are shared with the projects that already used them; see [Agent validation](./agent-validation.md).

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
