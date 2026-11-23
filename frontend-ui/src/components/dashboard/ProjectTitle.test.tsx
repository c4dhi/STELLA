// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectTitle } from './ProjectTitle'

afterEach(cleanup)

describe('ProjectTitle', () => {
  it('shows the name', () => {
    render(<ProjectTitle name="Pilot study" isDark={false} canEdit onEdit={() => {}} />)
    expect(screen.getByRole('heading').textContent).toBe('Pilot study')
  })

  it('the pencil opens the edit window', () => {
    const onEdit = vi.fn()
    render(<ProjectTitle name="Pilot study" isDark={false} canEdit onEdit={onEdit} />)
    fireEvent.click(screen.getByLabelText('Edit project'))
    expect(onEdit).toHaveBeenCalledTimes(1)
  })

  it('shows no pencil when the user cannot edit', () => {
    render(<ProjectTitle name="Pilot study" isDark={false} canEdit={false} onEdit={() => {}} />)
    expect(screen.queryByLabelText('Edit project')).toBeNull()
  })
})
