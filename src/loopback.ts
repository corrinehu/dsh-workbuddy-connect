/**
 * Shared loopback gates for the plugin's local HTTP surfaces: the loopback
 * shim and the same-origin web-status route. Both are only ever meant to be
 * addressed through the machine's loopback interface.
 *
 * @module dsh-workbuddy-connect/loopback
 */

/** Loopback hostnames a local plugin surface may be addressed by. */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/** Strip the optional :port from a Host header value, IPv6-bracket aware. */
export function hostnameOfHost(host: string): string {
  let hostname = host.trim().toLowerCase()
  if (hostname.startsWith('[')) {
    const end = hostname.indexOf(']')
    return end === -1 ? hostname : hostname.slice(0, end + 1)
  }
  // Only `name:port` with a single colon is a port; anything with more colons
  // is an (unbracketed) IPv6 literal and must not be truncated.
  const colon = hostname.lastIndexOf(':')
  if (colon !== -1 && !hostname.slice(0, colon).includes(':') && /^\d+$/.test(hostname.slice(colon + 1))) {
    hostname = hostname.slice(0, colon)
  }
  return hostname
}

/**
 * The request's Host header must name the loopback interface. A DNS-rebinding
 * page (attacker domain re-resolved to 127.0.0.1) sends its own domain in
 * Host, so this check drops those before any routing happens.
 */
export function hostIsLoopback(host: string | undefined): boolean {
  if (host === undefined || host.trim() === '') return false
  return LOOPBACK_HOSTS.has(hostnameOfHost(host))
}

/**
 * A browser-sent Origin (present header) must be loopback. Non-browser
 * clients (the plugin's own fetch calls) send no Origin at all and pass.
 */
export function originIsLoopback(origin: string | undefined): boolean {
  if (origin === undefined || origin.trim() === '') return true
  try {
    const { hostname } = new URL(origin)
    return LOOPBACK_HOSTS.has(hostname) || hostname === '::1'
  } catch {
    return false
  }
}
