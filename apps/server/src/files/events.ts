const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
const enc = new TextEncoder();
const MSG = enc.encode('event: files-changed\ndata: {}\n\n');

export function addSseClient(ctrl: ReadableStreamDefaultController<Uint8Array>) {
  clients.add(ctrl);
}

export function removeSseClient(ctrl: ReadableStreamDefaultController<Uint8Array>) {
  clients.delete(ctrl);
}

export function broadcastFilesChanged() {
  for (const ctrl of clients) {
    try {
      ctrl.enqueue(MSG);
    } catch {
      clients.delete(ctrl);
    }
  }
}
