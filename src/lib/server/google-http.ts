const TOKEN_ENDPOINTS = [
  'https://oauth2.googleapis.com/token',
  // Google also documents this OAuth endpoint. Use it only when the primary
  // host cannot be reached, never to retry an HTTP OAuth rejection.
  'https://www.googleapis.com/oauth2/v4/token'
];

function networkCodes(error: unknown): string[] {
  const value = error as {code?: unknown; cause?: unknown; errors?: unknown[]} | null;
  if (!value || typeof value !== 'object') return [];
  // DOMException.code is numeric, unlike Node's network error codes.
  return [typeof value.code === 'string' ? value.code : '', ...networkCodes(value.cause), ...(value.errors || []).flatMap(networkCodes)];
}

function connectionFailed(error: unknown) {
  const codes = networkCodes(error);
  if (codes.some(code => code.includes('CERT') || code.includes('SELF_SIGNED') || code.includes('ISSUER') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) return false;
  return codes.some(code => ['UND_ERR_CONNECT_TIMEOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'ETIMEDOUT'].includes(code));
}

function networkError(error: unknown, context: string): Error {
  const codes = networkCodes(error);
  const name = error instanceof Error ? error.name : '';
  let reason = 'La connexion réseau a échoué.';
  if (codes.some(code => code.includes('CERT') || code.includes('SELF_SIGNED') || code.includes('ISSUER') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')) {
    reason = 'Le certificat TLS n’a pas pu être vérifié. Vérifie les certificats et le proxy du serveur.';
  } else if (codes.some(code => ['ENOTFOUND', 'EAI_AGAIN'].includes(code))) {
    reason = 'Le serveur ne parvient pas à résoudre le nom de domaine Google (DNS).';
  } else if (name === 'TimeoutError' || name === 'AbortError' || codes.some(code => code.includes('TIMEOUT') || code === 'ETIMEDOUT')) {
    reason = 'Le délai de connexion ou de téléchargement à Google est dépassé.';
  }
  // Do not expose request bodies, credentials, download URLs or raw exceptions.
  return new Error(`${context} : impossible de joindre Google. ${reason} Réessaie la connexion Google Photos.`, {cause: error});
}

function retryableNetworkError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  return connectionFailed(error) || name === 'TimeoutError' || name === 'AbortError' ||
    networkCodes(error).some(code => ['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT'].includes(code));
}

export async function readGoogleResponse<T>(url: string, options: Omit<RequestInit, 'signal'>,
  context: string, read: (response: Response) => Promise<T>, timeoutMs: number) {
  // Retry only reads. A POST may already have succeeded even when its response
  // is lost; replaying it could create another session or consume an OAuth code.
  const attempts = (options.method || 'GET').toUpperCase() === 'GET' ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    let response: Response | undefined;
    try {
      response = await fetch(url, {...options, signal});
      // Keep the body read inside the timeout/error boundary. fetch() alone
      // resolves when headers arrive, before JSON or image bytes are received.
      return await read(response);
    } catch (error) {
      const failure = signal.aborted ? signal.reason : error;
      const temporary = retryableNetworkError(failure);
      if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
      if (temporary && attempt + 1 < attempts) {
        await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt));
        continue;
      }
      if (!response || temporary || networkCodes(failure).some(Boolean)) throw networkError(failure, context);
      // Validation and HTTP errors retain their own message and are not retried.
      throw error;
    }
  }
  throw new Error(`${context} : téléchargement impossible.`);
}

export async function exchangeGoogleCode(body: URLSearchParams) {
  for (const [index, endpoint] of TOKEN_ENDPOINTS.entries()) {
    try {
      return await fetch(endpoint, {method: 'POST',
        headers: {'Content-Type': 'application/x-www-form-urlencoded'}, body,
        redirect: 'error', signal: AbortSignal.timeout(20_000)});
    } catch (error) {
      if (index === 0 && connectionFailed(error)) continue;
      throw networkError(error, 'Connexion OAuth');
    }
  }
  throw new Error('Connexion OAuth indisponible.');
}
