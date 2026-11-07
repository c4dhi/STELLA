# Custom agents

Agents in this folder are **not** built into STELLA. They are ready-made packages you download and upload to your STELLA as your own agent, the same way you would upload one you wrote yourself. Built-in agents live in `agents/`; the database seed only reads that folder, so nothing here appears in the gallery until someone uploads it.

| Agent | What it does |
|---|---|
| [`elias-interviewer`](elias-interviewer/) | Runs an ELIAS interview guide word for word and writes every turn back to ELIAS |

## Upload one

1. Zip the **contents** of the agent's folder, so `agent.yaml` sits at the root of the zip:

   ```bash
   cd custom-agents/elias-interviewer && zip -r ../elias-interviewer.zip . -x 'tests/*' '*/__pycache__/*'
   ```

2. In STELLA, open **Deploy Agent**, go to **My Agents** and upload the zip. STELLA checks the package (manifest, Dockerfile, allowed base image) and tells you what to fix if it is turned away.
3. **Build** it from My Agents.
4. Wait for a system admin to approve it, then deploy it into a session like any other agent.
5. To let others use it, share it with projects (Settings → Agent Library → Share). Members of those projects can deploy it there; only you can build, re-upload, share or delete it.

Review is on by default (Settings → Platform Defaults → **Review uploaded agents**), so nothing you upload deploys until an admin approves it. If an admin turns review off, you can deploy your own upload as soon as it is built, and members of the projects you share it with can deploy it there. Either way, an upload you haven't shared is yours alone.

There is no review screen yet; an admin approves with `POST /admin/agent-types/<id>/approve`.

`src/agent-package/custom-agents.spec.ts` runs every package here through the same validation an upload goes through, so a package that would be turned away fails CI first.
