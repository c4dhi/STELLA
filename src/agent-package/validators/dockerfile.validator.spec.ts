import { DockerfileValidator } from './dockerfile.validator.js'

describe('DockerfileValidator', () => {
  const validator = new DockerfileValidator()

  it('rejects a disallowed real FROM even when an allowed image name appears later as plain text', () => {
    const content = [
      'FROM ubuntu:22.04',
      'WORKDIR /app',
      'CMD ["echo", "fetching artifacts from python:3.12-slim mirror"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.baseImage).toBe('ubuntu:22.04')
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('ubuntu:22.04'))).toBe(true)
  })

  it('accepts an allowed real FROM even when a disallowed-looking word follows "from" elsewhere', () => {
    const content = [
      'FROM python:3.12-slim',
      'WORKDIR /app',
      'CMD ["python3", "-c", "print(\'hello from foo\')"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.baseImage).toBe('python:3.12-slim')
    expect(result.valid).toBe(true)
  })

  it('resolves the final stage of a multi-stage build, ignoring --platform and COPY --from', () => {
    const content = [
      'FROM --platform=linux/amd64 python:3.11-slim AS builder',
      'RUN pip install --no-cache-dir -r requirements.txt',
      'FROM python:3.12-slim',
      'COPY --from=builder /app /app',
      'WORKDIR /app',
      'CMD ["python3", "app.py"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.baseImage).toBe('python:3.12-slim')
    expect(result.valid).toBe(true)
  })

  it('still blocks a real FROM scratch instruction', () => {
    const content = ['FROM scratch', 'WORKDIR /app', 'CMD ["./app"]'].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(false)
    expect(result.errors).toContain('FROM scratch is not allowed')
  })

  it('does not block on the words "scratch" or "from" appearing elsewhere as plain text', () => {
    const content = [
      'FROM python:3.12-slim',
      'WORKDIR /app',
      'CMD ["python3", "-c", "print(\'built from scratch, with love\')"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(true)
  })
})
