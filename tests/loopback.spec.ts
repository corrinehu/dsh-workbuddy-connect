import { describe, expect, it } from 'vitest'
import { hostIsLoopback, hostnameOfHost, originIsLoopback } from '../src/loopback.ts'

describe('hostnameOfHost', () => {
  it('strips the port from an IPv4 host', () => {
    expect(hostnameOfHost('127.0.0.1:39271')).toBe('127.0.0.1')
  })

  it('keeps an IPv6 host intact without a port', () => {
    expect(hostnameOfHost('[::1]')).toBe('[::1]')
  })

  it('strips the port from a bracketed IPv6 host', () => {
    expect(hostnameOfHost('[::1]:39271')).toBe('[::1]')
  })

  it('does not treat a bare IPv6 literal as host:port', () => {
    expect(hostnameOfHost('::1')).toBe('::1')
  })

  it('lowercases and trims', () => {
    expect(hostnameOfHost('  LocalHost:3080 ')).toBe('localhost')
  })
})

describe('hostIsLoopback', () => {
  it('accepts loopback hosts with and without ports', () => {
    expect(hostIsLoopback('127.0.0.1')).toBe(true)
    expect(hostIsLoopback('localhost:3080')).toBe(true)
    expect(hostIsLoopback('[::1]:3080')).toBe(true)
  })

  it('rejects other hostnames, missing, and empty values', () => {
    expect(hostIsLoopback('evil.example')).toBe(false)
    expect(hostIsLoopback('127.0.0.1.evil.example')).toBe(false)
    expect(hostIsLoopback(undefined)).toBe(false)
    expect(hostIsLoopback('')).toBe(false)
    expect(hostIsLoopback('  ')).toBe(false)
  })
})

describe('originIsLoopback', () => {
  it('passes absent and empty Origins (non-browser clients)', () => {
    expect(originIsLoopback(undefined)).toBe(true)
    expect(originIsLoopback('')).toBe(true)
    expect(originIsLoopback('  ')).toBe(true)
  })

  it('accepts loopback origins', () => {
    expect(originIsLoopback('http://127.0.0.1:3080')).toBe(true)
    expect(originIsLoopback('http://localhost:3080')).toBe(true)
    expect(originIsLoopback('http://[::1]:3080')).toBe(true)
  })

  it('rejects non-loopback and unparsable Origins', () => {
    expect(originIsLoopback('http://evil.example')).toBe(false)
    expect(originIsLoopback('http://127.0.0.1.evil.example')).toBe(false)
    expect(originIsLoopback('not a url')).toBe(false)
  })
})
