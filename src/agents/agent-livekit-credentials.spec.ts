import { TokenVerifier } from 'livekit-server-sdk'
import { agentLiveKitCredentials } from './agent-livekit-credentials.js'

// Test-only values, not a real LiveKit deployment's credentials.
const API_KEY = 'devkey-test'
const API_SECRET = 'devsecret-test-0123456789abcdef0123456789'

const base = {
  apiKey: API_KEY,
  apiSecret: API_SECRET,
  roomName: 'room-own',
  identity: 'agent-abc',
  name: 'Uploaded Agent',
}

describe('agentLiveKitCredentials', () => {
  it('gives a built-in agent the platform key and secret, as before', async () => {
    const creds = await agentLiveKitCredentials({ ...base, isBuiltIn: true })
    expect(creds).toEqual({ livekitApiKey: API_KEY, livekitApiSecret: API_SECRET })
  })

  it('gives an uploaded agent only a token, never the key or secret', async () => {
    const creds = await agentLiveKitCredentials({ ...base, isBuiltIn: false })
    expect(Object.keys(creds)).toEqual(['livekitToken'])
    expect(JSON.stringify(creds)).not.toContain(API_SECRET)
  })

  it("scopes the uploaded agent's token to its own room and identity only", async () => {
    const { livekitToken } = await agentLiveKitCredentials({ ...base, isBuiltIn: false })
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(livekitToken!)

    expect(claims.sub).toBe('agent-abc')
    expect(claims.name).toBe('Uploaded Agent')
    expect(claims.video).toEqual({
      roomJoin: true,
      room: 'room-own',
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
    })
    // LiveKit admits a token only to the room in its grant: nothing here lets
    // it join, create, list or administer any other room.
    expect(claims.video?.room).not.toBe('room-other')
    expect(claims.video?.roomAdmin).toBeUndefined()
    expect(claims.video?.roomCreate).toBeUndefined()
    expect(claims.video?.roomList).toBeUndefined()
  })

  it('lives for 24 hours, the same as a participant token', async () => {
    const before = Math.floor(Date.now() / 1000)
    const { livekitToken } = await agentLiveKitCredentials({ ...base, isBuiltIn: false })
    const claims = await new TokenVerifier(API_KEY, API_SECRET).verify(livekitToken!)
    expect(claims.exp! - before).toBeGreaterThanOrEqual(24 * 3600 - 5)
    expect(claims.exp! - before).toBeLessThanOrEqual(24 * 3600 + 5)
  })
})
