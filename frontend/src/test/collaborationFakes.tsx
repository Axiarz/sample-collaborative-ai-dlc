// Test seam for collaborative editing. Each hook instance gets its own Y.Doc,
// relayed through an in-memory "server" per document name, so two rendered
// clients converge like real Yjs peers. Token targets are recorded so tests
// can assert the exact revision-specific authorization requested. The real
// CollaborativeTextarea (CodeMirror) has its own CRDT/caret tests; this
// textarea stand-in exposes value/readonly to Testing Library.
import { useEffect, useMemo, useState } from 'react';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { RealtimeScopeTarget } from '@/lib/realtimeToken';

interface Peer {
  doc: Y.Doc;
  name: string;
  color: string;
}
// Like the Yjs server: a per-document state survives clients leaving until
// `expireDocument` (grace period elapsed / server restart).
const servers = new Map<string, Set<Peer>>();
const retained = new Map<string, Y.Doc>();
export const openedDocuments: { documentId: string; target?: RealtimeScopeTarget }[] = [];
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

export function resetCollaborationFakes() {
  servers.clear();
  retained.clear();
  openedDocuments.length = 0;
  listeners.clear();
}

/** Drop every client from a document: the server-side grace period expired. */
export function expireDocument(documentId: string) {
  if (servers.get(documentId)?.size) throw new Error('A connected client keeps the document alive');
  servers.delete(documentId);
  retained.delete(documentId);
}

export function useYjsDocument(
  documentId: string | null,
  userName?: string,
  userColor?: string,
  scopeTarget?: RealtimeScopeTarget,
) {
  // A new document must get a fresh Y.Doc, as in the real hook.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const doc = useMemo(() => new Y.Doc(), [documentId]);
  const awareness = useMemo(() => new awarenessProtocol.Awareness(doc), [doc]);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!documentId) return;
    openedDocuments.push({ documentId, target: scopeTarget });
    const peers = servers.get(documentId) ?? new Set<Peer>();
    servers.set(documentId, peers);
    const self: Peer = { doc, name: userName ?? '', color: userColor ?? '' };
    const server = retained.get(documentId) ?? new Y.Doc();
    retained.set(documentId, server);
    // Initial sync from the server state, then relay every update.
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(server), 'remote');
    peers.add(self);
    const relay = (update: Uint8Array, origin: unknown) => {
      if (origin === 'remote') return;
      Y.applyUpdate(server, update, 'remote');
      for (const peer of servers.get(documentId) ?? []) {
        if (peer !== self) Y.applyUpdate(peer.doc, update, 'remote');
      }
    };
    doc.on('update', relay);
    const rerender = () => setTick((n) => n + 1);
    listeners.add(rerender);
    notify();
    return () => {
      doc.off('update', relay);
      servers.get(documentId)?.delete(self);
      listeners.delete(rerender);
      notify();
    };
    // Like the real hook: keyed on the document, not the target object identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [documentId, doc, userName, userColor]);
  const remoteUsers = new Map<number, { name: string; color: string }>();
  for (const peer of (documentId && servers.get(documentId)) || []) {
    if (peer.doc !== doc) remoteUsers.set(peer.doc.clientID, { name: peer.name, color: peer.color });
  }
  return { doc, synced: Boolean(documentId), awareness, remoteUsers, setCursor: () => {} };
}

export function CollaborativeTextarea({
  id,
  'aria-label': ariaLabel,
  yText,
  value = '',
  disabled = false,
  rows,
}: {
  id?: string;
  'aria-label'?: string;
  yText?: Y.Text;
  value?: string;
  disabled?: boolean;
  rows?: number;
}) {
  const [text, setText] = useState(() => yText?.toString() ?? value);
  useEffect(() => {
    if (!yText) {
      setText(value);
      return;
    }
    const update = () => setText(yText.toString());
    update();
    yText.observe(update);
    return () => yText.unobserve(update);
  }, [yText, value]);
  return (
    <textarea
      id={id}
      aria-label={ariaLabel}
      rows={rows}
      readOnly={disabled}
      value={text}
      onChange={(event) => {
        if (!yText || disabled) return;
        const next = event.target.value;
        yText.doc?.transact(() => {
          yText.delete(0, yText.length);
          yText.insert(0, next);
        });
      }}
    />
  );
}
