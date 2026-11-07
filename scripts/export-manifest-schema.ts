import * as fs from 'fs'
import * as path from 'path'
import { MANIFEST_JSON_SCHEMA_PATH, manifestJsonSchema } from '../src/agent-package/schemas/agent-manifest.schema.js'

// Regenerate the published agent.yaml JSON Schema from the zod schema.
const target = path.join(process.cwd(), MANIFEST_JSON_SCHEMA_PATH)
fs.mkdirSync(path.dirname(target), { recursive: true })
fs.writeFileSync(target, JSON.stringify(manifestJsonSchema(), null, 2) + '\n')
console.log(`Wrote ${MANIFEST_JSON_SCHEMA_PATH}`)
