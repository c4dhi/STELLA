import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { motion } from 'framer-motion'
import { Globe, Users, Settings } from 'lucide-react'
import { apiClient } from '../services/ApiClient'
import { useThemeStore } from '../store/themeStore'
import { useToastStore } from '../store/toastStore'
import ProjectModal from '../components/modals/ProjectModal'
import ShareProjectModal from '../components/modals/ShareProjectModal'
import DeleteProjectModal from '../components/modals/DeleteProjectModal'
import AppHeader from '../components/layout/AppHeader'
import type { ProjectWithCounts, Project } from '../lib/api-types'

export default function ProjectsDashboard() {
  const navigate = useNavigate()
  const { resolvedTheme, initializeTheme } = useThemeStore()
  const { addToast } = useToastStore()
  const isDark = resolvedTheme === 'dark'

  const [projects, setProjects] = useState<ProjectWithCounts[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<ProjectWithCounts | null>(null)
  const [sharingProject, setSharingProject] = useState<ProjectWithCounts | null>(null)
  const [deleteModalOpen, setdeleteModalOpen] = useState(false)
  const [projectToDelete, setProjectToDelete] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    initializeTheme()
  }, [initializeTheme])

  const loadProjects = async () => {
    try {
      setIsLoading(true)
      setError(null)
      const data = await apiClient.listProjects()
      setProjects(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load projects')
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    loadProjects()
  }, [])

  const handleProjectCreated = (projectId: string) => {
    // Reload projects list to get the new project with all counts
    loadProjects()
    addToast({ message: 'Project created', type: 'success' })
  }

  const handleProjectUpdated = (updatedProject: Project) => {
    setProjects(prev =>
      prev.map(p => (p.id === updatedProject.id ? { ...p, ...updatedProject } : p))
    )
    addToast({ message: 'Project settings updated', type: 'success' })
  }

  const handleDeleteProject = (projectId: string, projectName: string) => {
    setProjectToDelete({ id: projectId, name: projectName })
    setdeleteModalOpen(true)
  }

  const confirmDeleteProject = async () => {
    if (!projectToDelete) return
    try {
      await apiClient.deleteProject(projectToDelete.id)
      setProjects(prev => prev.filter(p => p.id !== projectToDelete.id))
      addToast({ message: `Project "${projectToDelete.name}" deleted`, type: 'success' })
    } catch (err) {
      addToast({
        message: err instanceof Error ? err.message : 'Failed to delete project',
        type: 'error'
      })
    } finally {
      setdeleteModalOpen(false)
      setProjectToDelete(null)
    }
  }

  return (
    <div className={`min-h-screen transition-colors duration-200 ${
      isDark ? 'bg-surface-dark' : 'bg-surface'
    }`}>
      <AppHeader />

      {/* Main Content */}
      <main className="max-w-6xl mx-auto px-6 py-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h2 className={`text-heading-lg ${
              isDark ? 'text-content-inverse' : 'text-content'
            }`}>
              Projects
            </h2>
            <p className={`text-body mt-1 ${
              isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'
            }`}>
              Manage your AI session projects
            </p>
          </div>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="btn-primary flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
            New Project
          </button>
        </div>

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <div className={`text-body ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
              Loading projects...
            </div>
          </div>
        )}

        {/* Error */}
        {error && !isLoading && (
          <div className={`p-4 rounded-lg text-body ${
            isDark
              ? 'bg-red-500/10 border border-red-500/20 text-red-400'
              : 'bg-red-50 border border-red-200 text-red-700'
          }`}>
            {error}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && !error && projects.length === 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-center py-20"
          >
            <div className={`w-16 h-16 rounded-2xl mx-auto mb-4 flex items-center justify-center ${
              isDark ? 'bg-surface-dark-secondary' : 'bg-surface-secondary'
            }`}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" className={
                isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
              } stroke="currentColor" strokeWidth="1.5">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </div>
            <h3 className={`text-heading mb-2 ${isDark ? 'text-content-inverse' : 'text-content'}`}>
              No projects yet
            </h3>
            <p className={`text-body mb-6 ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
              Create your first project to get started
            </p>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="btn-primary"
            >
              Create Project
            </button>
          </motion.div>
        )}

        {/* Projects Grid */}
        {!isLoading && !error && projects.length > 0 && (
          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4"
            initial="hidden"
            animate="visible"
            variants={{
              hidden: {},
              visible: { transition: { staggerChildren: 0.05 } }
            }}
          >
            {projects.map((project) => (
              <motion.div
                key={project.id}
                variants={{
                  hidden: { opacity: 0, y: 20 },
                  visible: { opacity: 1, y: 0, transition: { duration: 0.3 } }
                }}
                onClick={() => navigate(`/project/${project.id}`)}
                className={`group cursor-pointer rounded-xl p-5 transition-[color,background-color,border-color,box-shadow] duration-200 ${
                  isDark
                    ? 'bg-surface-dark-secondary border border-border-dark hover:border-border-dark-secondary'
                    : 'bg-white border border-border shadow-sm hover:shadow-md hover:border-border-secondary'
                }`}
              >
                <div className="flex items-center gap-2 mb-3">
                  <h3 className={`text-heading-sm ${
                    isDark ? 'text-content-inverse' : 'text-content'
                  }`}>
                    {project.name}
                  </h3>
                  {project.isPublic && (
                    <Globe className={`w-4 h-4 flex-shrink-0 ${
                      isDark ? 'text-violet-400' : 'text-violet-600'
                    }`} />
                  )}
                </div>

                {/* Stats */}
                <div className="space-y-2 mb-4">
                  <div className="flex items-center justify-between">
                    <span className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                      Active Sessions
                    </span>
                    <span className={`text-body-sm font-medium ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                      {project.activeSessions}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                      Active Agents
                    </span>
                    <span className={`text-body-sm font-medium ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                      {project.activeAgents}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className={`text-body-sm ${isDark ? 'text-content-inverse-secondary' : 'text-content-secondary'}`}>
                      Total Sessions
                    </span>
                    <span className={`text-body-sm font-medium ${isDark ? 'text-content-inverse' : 'text-content'}`}>
                      {project.totalSessions}
                    </span>
                  </div>
                </div>

                {/* Date */}
                <p className={`text-caption mb-4 ${
                  isDark ? 'text-content-inverse-tertiary' : 'text-content-tertiary'
                }`}>
                  Created {new Date(project.createdAt).toLocaleDateString()}
                </p>

                {/* Actions */}
                <div className={`flex gap-2 coarse:gap-3 pt-4 border-t ${
                  isDark ? 'border-border-dark' : 'border-border'
                }`}>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      navigate(`/project/${project.id}`)
                    }}
                    className="btn-primary flex-1 text-ui-sm"
                  >
                    View Sessions
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setSharingProject(project)
                    }}
                    className={`p-2 rounded-lg transition-colors ${
                      isDark
                        ? 'text-content-inverse-tertiary hover:text-content-inverse hover:bg-surface-dark-tertiary'
                        : 'text-content-tertiary hover:text-content hover:bg-surface-secondary'
                    }`}
                    title="Share"
                  >
                    <Users className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      setEditingProject(project)
                    }}
                    className={`p-2 rounded-lg transition-colors ${
                      isDark
                        ? 'text-content-inverse-tertiary hover:text-content-inverse hover:bg-surface-dark-tertiary'
                        : 'text-content-tertiary hover:text-content hover:bg-surface-secondary'
                    }`}
                    title="Settings"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      handleDeleteProject(project.id, project.name)
                    }}
                    className={`p-2 rounded-lg transition-colors ${
                      isDark
                        ? 'text-content-inverse-tertiary hover:text-red-400 hover:bg-red-500/10'
                        : 'text-content-tertiary hover:text-red-600 hover:bg-red-50'
                    }`}
                    title="Delete"
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                      <path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                    </svg>
                  </button>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </main>

      {/* Modals */}
      <ProjectModal
        isOpen={isCreateModalOpen}
        onClose={() => setIsCreateModalOpen(false)}
        onProjectCreated={handleProjectCreated}
      />

      {editingProject && (
        <ProjectModal
          isOpen={!!editingProject}
          onClose={() => setEditingProject(null)}
          project={editingProject}
          onProjectUpdated={handleProjectUpdated}
        />
      )}

      <DeleteProjectModal
        isOpen={deleteModalOpen}
        projectName={projectToDelete?.name || ''}
        onConfirm={confirmDeleteProject}
        onCancel={() => {
          setdeleteModalOpen(false)
          setProjectToDelete(null)
        }}
      />

      {sharingProject && (
        <ShareProjectModal
          isOpen={!!sharingProject}
          onClose={() => setSharingProject(null)}
          projectId={sharingProject.id}
          projectName={sharingProject.name}
          isOwner={sharingProject.isOwner ?? true}
        />
      )}
    </div>
  )
}
