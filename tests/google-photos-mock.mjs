// Loaded only by the integration test's isolated server process.
import assert from 'node:assert/strict';
import { photo, video } from './fixtures.mjs';

const originalFetch = globalThis.fetch;
const sessions = new Map();
let sessionCount = 0;
const scope = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const asJson = (data, init) => Response.json(data, init);
const tokenAttempts = new Map();
const mediaAttempts = new Map();
const sessionCreations = new Map();

function timedOutResponse(prefix = new Uint8Array([1, 2, 3])) {
  let sent = false;
  return new Response(new ReadableStream({pull(controller) {
    if (!sent) { sent = true; controller.enqueue(prefix); }
    else controller.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'));
  }}));
}

function item(id, createTime, path = id) {
  return {id, createTime, type: 'PHOTO', mediaFile: {filename: `${id}.jpg`, mimeType: 'image/jpeg',
    baseUrl: `https://lh3.googleusercontent.com/${path}`}};
}

globalThis.fetch = async (input, init = {}) => {
  const url = new URL(String(input));
  if (url.hostname === 'oauth2.googleapis.com' || (url.hostname === 'www.googleapis.com' && url.pathname === '/oauth2/v4/token')) {
    const form = new URLSearchParams(init.body);
    if (form.get('grant_type') === 'refresh_token') {
      assert.equal(form.get('client_secret'), 'test-client-secret');
      assert.match(form.get('refresh_token'), /^test-refresh-token:/);
      const scenario = form.get('refresh_token').split(':').at(-1);
      if (scenario === 'revoked-token') return asJson({error: 'invalid_grant'}, {status: 400});
      return asJson({access_token: `test-access-token:${scenario}-refreshed`, expires_in: 3600});
    }
    const scenario = form.get('code');
    const attempts = (tokenAttempts.get(scenario) || 0) + 1;
    tokenAttempts.set(scenario, attempts);
    if (scenario === 'fallback' || scenario === 'both-unreachable') {
      if (url.hostname === 'oauth2.googleapis.com' || scenario === 'both-unreachable') {
        throw new TypeError('fetch failed: secret-request-details', {cause: Object.assign(new Error('network timeout'), {code: 'UND_ERR_CONNECT_TIMEOUT'})});
      }
      assert.equal(attempts, 2);
    }
    if (scenario === 'oauth-rejected') {
      assert.equal(attempts, 1, 'OAuth HTTP failures must not be retried on another endpoint');
      return asJson({error: 'invalid_client'}, {status: 400});
    }
    if (scenario === 'tls-failure') {
      assert.equal(attempts, 1, 'TLS verification failures must not trigger a fallback');
      throw new TypeError('fetch failed: secret-request-details', {cause: Object.assign(new Error('certificate error'), {code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'})});
    }
    assert.equal(form.get('client_secret'), 'test-client-secret');
    assert.equal(form.get('grant_type'), 'authorization_code');
    assert.ok(form.get('code_verifier').length >= 43);
    return asJson({access_token: `test-access-token:${form.get('code')}`, refresh_token: `test-refresh-token:${form.get('code')}`,
      scope, expires_in: ['short-token', 'revoked-token'].includes(scenario) ? 61 : 3600});
  }
  if (url.hostname === 'photospicker.googleapis.com') {
    const token = init.headers.Authorization;
    assert.match(token, /^Bearer test-access-token:/);
    const scenario = token.split(':').at(-1);
    if (scenario === 'picker-unreachable') throw new TypeError('fetch failed', {cause: Object.assign(new Error('DNS failure'), {code: 'ENOTFOUND'})});
    if (url.pathname === '/v1/sessions' && init.method === 'POST') {
      const creations = (sessionCreations.get(scenario) || 0) + 1;
      sessionCreations.set(scenario, creations);
      if (scenario === 'short-token' || scenario === 'revoked-token') assert.equal(creations, 1, 'An expired access token must be refreshed');
      assert.equal(JSON.parse(init.body).pickingConfig?.maxItemCount, undefined);
      const id = `session-${++sessionCount}`;
      const session = {id, pickerUri: `https://photos.google.com/picker/${id}`, mediaItemsSet: false};
      sessions.set(id, session);
      return asJson(session);
    }
    if (url.pathname.startsWith('/v1/sessions/')) {
      const id = url.pathname.split('/').at(-1);
      if (init.method === 'DELETE') { sessions.delete(id); return asJson({}); }
      return asJson({...sessions.get(id), mediaItemsSet: true, pollingConfig: {pollInterval: '5s'}});
    }
    if (url.pathname === '/v1/mediaItems') {
      assert.equal(url.searchParams.get('pageSize'), '100');
      if (scenario === 'videos') {
        const clip = (id, status) => ({id, type: 'VIDEO', createTime: '2023-07-01T23:30:00Z', mediaFile: {
          filename: `${id}.mp4`, mimeType: 'video/mp4', baseUrl: `https://lh3.googleusercontent.com/${id}`,
          mediaFileMetadata: {videoMetadata: {processingStatus: status}}
        }});
        return asJson({mediaItems: [clip('google-video', 'READY'), clip('google-processing', 'PROCESSING')]});
      }
      if (scenario === 'chronological') return asJson({mediaItems: [
        item('google-late', '2022-12-02T23:30:00Z'),
        item('google-early', '2022-12-02T23:10:00Z')
      ]});
      if (scenario === 'metadata-timeout') {
        const attempts = (mediaAttempts.get(scenario) || 0) + 1;
        mediaAttempts.set(scenario, attempts);
        if (attempts < 3) return timedOutResponse(new TextEncoder().encode('{"mediaItems":['));
        assert.equal(attempts, 3);
        return asJson({mediaItems: [item('metadata-recovered', '2025-02-01T10:00:00Z')]});
      }
      if (['stream-timeout', 'stream-permanent', 'connection-timeout', 'oversize'].includes(scenario)) {
        return asJson({mediaItems: [item(scenario, '2025-02-02T10:00:00Z'),
          ...(scenario === 'stream-permanent' ? [item('after-timeout', '2025-02-02T10:00:00Z')] : [])]});
      }
      if (scenario === 'large-selection' || scenario === 'full-selection') {
        const total = scenario === 'large-selection' ? 105 : 2000;
        const offset = Number(url.searchParams.get('pageToken') || '0');
        assert.ok(Number.isInteger(offset) && offset >= 0 && offset < total);
        const count = Math.min(100, total - offset);
        return asJson({mediaItems: Array.from({length: count}, (_, i) => item(`${scenario}-${offset + i}`, '2025-01-01T10:00:00Z')),
          ...(offset + count < total ? {nextPageToken: String(offset + count)} : {})});
      }
      if (scenario === 'page-cycle') return asJson({mediaItems: [], nextPageToken: 'cycle'});
      if (scenario === 'local-duplicate') return asJson({mediaItems: [item('google-local', '2024-12-01T10:00:00Z', 'local')]});
      if (scenario === 'partial') {
        const invalid = item('google-invalid', '2024-12-12T10:00:00Z');
        invalid.mediaFile.baseUrl = 'http://127.0.0.1/private';
        return asJson({mediaItems: [item('google-partial', '2024-12-11T10:00:00Z'), invalid]});
      }
      return asJson({mediaItems: [item('google-a', '2024-11-01T22:00:00Z'), item('google-b', '2024-11-02T23:30:00Z')]});
    }
    throw new Error(`Unexpected Google API path: ${url.pathname}`);
  }
  if (url.hostname === 'lh3.googleusercontent.com') {
    assert.match(init.headers.Authorization, /^Bearer test-access-token:/);
    assert.equal(init.redirect, 'error');
    const isVideo = url.pathname.endsWith('=dv');
    assert.ok(url.pathname.endsWith('=d') || isVideo);
    if (init.headers.Authorization.endsWith(':repeat')) return new Response('Duplicate should not be downloaded', {status: 500});
    if (init.headers.Authorization.endsWith(':large-selection')) await new Promise(resolve => setTimeout(resolve, 8));
    const path = url.pathname.slice(1, isVideo ? -3 : -2);
    if (isVideo) {
      assert.equal(path, 'google-video');
      const fixture = await video('google-video.mp4', {date: null});
      return new Response(fixture.buffer, {headers: {'Content-Type': fixture.type}});
    }
    const attempts = (mediaAttempts.get(path) || 0) + 1;
    mediaAttempts.set(path, attempts);
    if (path === 'stream-timeout' || path === 'stream-permanent' || path === 'connection-timeout') {
      assert.ok(attempts <= 3, 'Network retries must be bounded');
      if (path === 'stream-permanent' || attempts < 3) {
        if (path === 'connection-timeout') throw new TypeError('fetch failed', {cause: Object.assign(new Error('connect timeout'), {code: 'UND_ERR_CONNECT_TIMEOUT'})});
        return timedOutResponse();
      }
    }
    if (path === 'oversize') {
      assert.equal(attempts, 1, 'Oversized files must not be downloaded repeatedly');
      return new Response(new Uint8Array(12 * 1024 * 1024 + 1));
    }
    let fixture;
    if (path === 'local') fixture = await photo('from-local.jpg', '2024:12:01 10:00:00');
    else if (path === 'google-a') fixture = await photo('google-a.jpg', '2024:11:01 23:00:00');
    else fixture = await photo(`${path}.jpg`, null);
    return new Response(fixture.buffer, {headers: {'Content-Type': fixture.type}});
  }
  return originalFetch(input, init);
};
