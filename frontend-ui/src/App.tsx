import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { useEffect } from 'react'
import LoginPage from './pages/LoginPage'
import ProjectsDashboard from './pages/ProjectsDashboard'
import SessionsDashboard from './pages/SessionsDashboard'
import SessionView from './pages/SessionView'
import SettingsPage from './pages/SettingsPage'
import ParticipantJoinPage from './pages/ParticipantJoinPage'
import PublicProjectJoinPage from './pages/PublicProjectJoinPage'
import StatusPage from './pages/StatusPage'
import ProtectedRoute from './components/auth/ProtectedRoute'
import FacePreviewPage from './pages/FacePreviewPage'
import { ToastContainer } from './components/Toast'
import PlanBuilderModal from './components/settings/PlanBuilder/PlanBuilderModal'
import GlobalConfiguratorModal from './components/configurator/GlobalConfiguratorModal'
import { useAuthStore } from './store/authStore'
import { useToastStore } from './store/toastStore'
import { useNotificationStore } from './store/notificationStore'

export default function App() {
  const { checkAuth, isAuthenticated } = useAuthStore()
  const { toasts, removeToast } = useToastStore()
  const { initialize, disconnect } = useNotificationStore()

  // Check authentication status on app mount
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  // Manage notification SSE connection based on auth state.
  // Placed here (App never unmounts) so route changes don't tear down the connection.
  useEffect(() => {
    if (isAuthenticated) {
      initialize()
    } else {
      disconnect()
    }
  }, [isAuthenticated])

  return (
    <BrowserRouter>
      {/* Toast Notifications */}
      <ToastContainer toasts={toasts} onRemove={removeToast} />

      {/* Global Plan Builder Modal */}
      <PlanBuilderModal />

      {/* Global Pipeline Configurator Modal */}
      <GlobalConfiguratorModal />

      <Routes>
        {/* Public Routes */}
        <Route path="/login" element={<LoginPage />} />
        <Route path="/join/:token" element={<ParticipantJoinPage />} />
        <Route path="/p/:publicToken" element={<PublicProjectJoinPage />} />
        <Route path="/status" element={<StatusPage />} />
        {/* Face preview (#face-emotions): compare expressions without a session. */}
        <Route path="/face-preview" element={<FacePreviewPage />} />

        {/* Protected Routes */}
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <ProjectsDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/project/:projectId"
          element={
            <ProtectedRoute>
              <SessionsDashboard />
            </ProtectedRoute>
          }
        />
        <Route
          path="/session/:sessionId"
          element={
            <ProtectedRoute>
              <SessionView />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/settings/:section"
          element={
            <ProtectedRoute>
              <SettingsPage />
            </ProtectedRoute>
          }
        />

        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />

        {/* Catch-all - redirect to dashboard */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  )
}
