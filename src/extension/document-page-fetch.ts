export interface DocumentPageRequest {
  action: 'metadata' | 'prepare' | 'fetch' | 'cancel';
  key?: string;
  url?: string;
  accept?: string;
  deadline?: number;
  kind?: string;
}

export interface DocumentPageResult {
  outcome: 'metadata' | 'prepared' | 'response' | 'network' | 'cancelled' | 'invalid';
  url?: string;
  origin?: string;
  ok?: boolean;
  status?: number;
  text?: string;
  base64?: string;
}

// Chrome serializes this function, so its runtime dependencies stay inside it.
export async function documentPageFetch(request: DocumentPageRequest): Promise<DocumentPageResult> {
  const scope = globalThis as typeof globalThis & {
    __cobrowserDocumentFetches?: Map<
      string,
      { controller: AbortController; timer: ReturnType<typeof setTimeout> }
    >;
  };
  if (request.action === 'metadata')
    return { outcome: 'metadata', url: location.href, origin: location.origin };
  const pending = (scope.__cobrowserDocumentFetches ??= new Map());
  const key = request.key || '';
  if (request.action === 'cancel') {
    const item = pending.get(key);
    if (item) {
      item.controller.abort();
      clearTimeout(item.timer);
      pending.delete(key);
    }
    return { outcome: 'cancelled' };
  }
  if (request.action === 'prepare') {
    if (pending.size >= 16 || pending.has(key) || !key || !request.deadline)
      return { outcome: 'invalid' };
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        controller.abort();
        pending.delete(key);
      },
      Math.max(1, request.deadline - Date.now()),
    );
    pending.set(key, { controller, timer });
    return { outcome: 'prepared' };
  }
  const item = pending.get(key);
  if (!item || !request.url || !request.deadline) return { outcome: 'invalid' };
  try {
    let response: Response;
    try {
      response = await fetch(request.url, {
        credentials: 'include',
        redirect: request.url.startsWith('file:') ? 'error' : 'follow',
        headers: request.accept ? { Accept: request.accept } : undefined,
        signal: item.controller.signal,
      });
    } catch {
      return { outcome: item.controller.signal.aborted ? 'cancelled' : 'network' };
    }
    const metadata = {
      outcome: 'response' as const,
      url: response.url,
      status: response.status,
      ok: response.ok,
    };
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return metadata;
    }
    const limit = request.kind === 'pdf' ? 45 * 1024 * 1024 : 32 * 1024 * 1024;
    const contentLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(contentLength) && contentLength > limit) {
      await response.body?.cancel().catch(() => undefined);
      return { ...metadata, ok: false, status: 413 };
    }
    let bytes: Uint8Array;
    try {
      const reader = response.body?.getReader();
      if (!reader) bytes = new Uint8Array(await response.arrayBuffer());
      else {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > limit) {
            await reader.cancel();
            return { ...metadata, ok: false, status: 413 };
          }
          chunks.push(next.value);
        }
        bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
      }
    } catch {
      return { outcome: item.controller.signal.aborted ? 'cancelled' : 'network' };
    }
    if (bytes.byteLength > limit) return { ...metadata, ok: false, status: 413 };
    if (request.kind === 'pdf') {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 0x8000)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      return { ...metadata, base64: btoa(binary) };
    }
    const text = new TextDecoder().decode(bytes);
    if (
      new TextEncoder().encode(text).byteLength > 32 * 1024 * 1024 ||
      new TextEncoder().encode(JSON.stringify({ text })).byteLength > 48 * 1024 * 1024
    )
      return { ...metadata, ok: false, status: 413 };
    return { ...metadata, text };
  } catch {
    return { outcome: 'invalid' };
  } finally {
    clearTimeout(item.timer);
    pending.delete(key);
  }
}
