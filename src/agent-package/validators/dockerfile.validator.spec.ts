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

  it('rejects a disallowed real FROM even when a continued RUN line contains a fake "FROM <allowed>"', () => {
    const content = [
      'FROM ubuntu:22.04',
      'RUN apt-get update && \\',
      '    FROM python:3.12-slim',
      'WORKDIR /app',
      'CMD ["./app"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.baseImage).toBe('ubuntu:22.04')
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('ubuntu:22.04'))).toBe(true)
  })

  it('rejects a disallowed real FROM even when a heredoc body contains a fake "FROM <allowed>"', () => {
    const content = [
      'FROM ubuntu:22.04',
      'RUN <<EOF',
      'echo setting up',
      'FROM python:3.12-slim',
      'EOF',
      'WORKDIR /app',
      'CMD ["./app"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.baseImage).toBe('ubuntu:22.04')
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('ubuntu:22.04'))).toBe(true)
  })

  it('rejects a Docker Hub namespace masquerading as an official allowed image', () => {
    const content = ['FROM user/python:3.12-slim', 'WORKDIR /app', 'CMD ["./app"]'].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('user/python:3.12-slim'))).toBe(true)
  })

  it('still allows an official image behind a real registry host, with or without the library/ namespace', () => {
    const content = [
      'FROM docker.io/library/python:3.12-slim AS builder',
      'FROM myregistry.example.com:5000/python:3.12-slim',
      'WORKDIR /app',
      'CMD ["./app"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(true)
  })

  it('rejects a disallowed base image in an earlier build stage, even when the final stage is allowed', () => {
    const content = [
      'FROM ubuntu:22.04 AS builder',
      'RUN make build',
      'FROM python:3.12-slim',
      'COPY --from=builder /app /app',
      'WORKDIR /app',
      'CMD ["./app"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('ubuntu:22.04'))).toBe(true)
  })

  it('rejects a COPY --from that pulls from a disallowed external image, not a build stage', () => {
    const content = [
      'FROM python:3.12-slim',
      'COPY --from=ubuntu:22.04 /etc/passwd /tmp/passwd',
      'WORKDIR /app',
      'CMD ["./app"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('ubuntu:22.04'))).toBe(true)
  })

  it('allows a COPY --from that references an earlier stage by its numeric index', () => {
    const content = [
      'FROM python:3.12-slim',
      'RUN make build',
      'FROM python:3.12-slim',
      'COPY --from=0 /app /app',
      'WORKDIR /app',
      'CMD ["./app"]',
    ].join('\n')

    const result = validator.validate(content)

    expect(result.valid).toBe(true)
  })
})
