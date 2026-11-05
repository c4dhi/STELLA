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
4. Deploy it into a session like any other agent. You can deploy your own upload as soon as it is built.

Two things depend on review:

- **Other users** can deploy your upload only after a system admin approves it.
- If a system admin has turned on **Review uploaded agents** (Settings → Platform Defaults), nothing you upload deploys until an admin approves it.

There is no review screen yet; an admin approves with `POST /admin/agent-types/<id>/approve`.

`src/agent-package/custom-agents.spec.ts` runs every package here through the same validation an upload goes through, so a package that would be turned away fails CI first.
