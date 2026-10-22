// Optional platform features a system admin can switch on or off, so the UI
// can hide what is off. Loaded once per page load; refresh() after a change.
import { create } from 'zustand'
import { apiClient } from '../services/ApiClient'

interface FeatureFlagsState {
  mcpEnabled: boolean
  loaded: boolean
  load: () => Promise<void>
  refresh: () => Promise<void>
  setMcpEnabled: (enabled: boolean) => void
}

export const useFeatureFlagsStore = create<FeatureFlagsState>((set, get) => ({
  mcpEnabled: false,
  loaded: false,
  load: async () => {
    if (get().loaded) return
    await get().refresh()
  },
  refresh: async () => {
    try {
      const features = await apiClient.getPlatformFeatures()
      set({ mcpEnabled: features.mcpEnabled, loaded: true })
    } catch {
      // Unknown means hidden: the feature stays off in the UI.
      set({ mcpEnabled: false, loaded: true })
    }
  },
  setMcpEnabled: (enabled) => set({ mcpEnabled: enabled, loaded: true }),
}))
