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
3. A **system admin approves** the upload. Uploaded code runs in the cluster, so nothing deploys until an admin has reviewed it. There is no review screen yet; an admin calls `POST /admin/agent-types/<id>/approve`.
4. **Build** it from My Agents. The agent can be deployed once the build has finished.
5. Deploy it into a session like any other agent.

`src/agent-package/custom-agents.spec.ts` runs every package here through the same validation an upload goes through, so a package that would be turned away fails CI first.
