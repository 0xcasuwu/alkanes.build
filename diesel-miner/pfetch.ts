/**
 * Proxy-aware Fetch Module
 * 
 * This container routes all traffic through an HTTP proxy (no DNS available).
 * Node.js native fetch() doesn't respect HTTPS_PROXY env vars, so we use
 * undici's ProxyAgent to route all requests through the egress proxy.
 * 
 * If no proxy is configured (e.g. running on a normal machine), falls back
 * to native fetch transparently.
 */

import { ProxyAgent, fetch as undiciFetch, type RequestInfo, type RequestInit } from 'undici';

const PROXY_URL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || process.env.https_proxy || process.env.http_proxy;

let dispatcher: ProxyAgent | undefined;
if (PROXY_URL) {
  dispatcher = new ProxyAgent(PROXY_URL);
}

/**
 * Drop-in replacement for global fetch() that routes through the proxy.
 * When deployed on a normal machine with DNS, this still works fine (no proxy = native behavior).
 */
export async function pfetch(url: string | URL | Request, init?: any): Promise<Response> {
  if (dispatcher) {
    // Use undici's fetch with ProxyAgent
    const resp = await undiciFetch(url as any, { ...init, dispatcher } as any);
    return resp as unknown as Response;
  }
  // No proxy configured — use native fetch
  return fetch(url as any, init);
}

export default pfetch;
