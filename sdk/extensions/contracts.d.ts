export interface Snippet {
  id: string;
  language: 'javascript' | 'typescript' | 'python' | 'json' | 'markdown' | 'plaintext';
  prefix: string;
  body: string;
  description?: string;
}

export interface Palette {
  id: string;
  label: string;
  colors: { background: string; foreground: string; accent: string };
}

type NonEmpty<T> = [T, ...T[]];
type Empty = Record<string, never>;

export interface Contributions {
  snippets?: NonEmpty<Snippet>;
  themes?: NonEmpty<Palette>;
}

export type Permission =
  | { capability: 'commands.register' }
  | { capability: 'workspace.read'; files: NonEmpty<string>; drafts?: boolean }
  | { capability: 'editor.readSelection' | 'diagnostics.publish' | 'editor.proposeEdit'; files: NonEmpty<string> };

interface ManifestFields {
  id: string;
  version: string;
  displayName: string;
  description: string;
  engines: { cevra: string };
}

export interface DeclarativeManifest extends ManifestFields {
  schemaVersion: 1;
  permissions: [];
  contributes: Contributions & ({ snippets: NonEmpty<Snippet> } | { themes: NonEmpty<Palette> });
}

export interface ExecutableManifest extends ManifestFields {
  schemaVersion: 2;
  runtime: { apiVersion: '0.1'; entry: 'extension.wasm' };
  permissions: NonEmpty<Permission>;
  contributes: Contributions;
}

export type ExtensionManifest = DeclarativeManifest | ExecutableManifest;

export interface TextRange {
  /** UTF-16 offsets into the complete normalized document. */
  from: number;
  to: number;
}

export interface FileSnapshot {
  fileHandle: string;
  pathLabel: string;
  text: string;
  revision: string;
  source: 'disk' | 'draft';
}

export interface SelectionSnapshot extends FileSnapshot {
  text: string; // Only the selected text.
  source: 'draft';
  selection: TextRange;
}

export interface Diagnostic extends TextRange {
  severity: 'error' | 'warning' | 'info';
  message: string;
}

interface RevisionTarget {
  fileHandle: string;
  expectedRevision: string;
}

export interface BrokerMethods {
  'workspace.readFile': {
    params: { path: string; source: 'disk' | 'draft' };
    result: FileSnapshot;
  };
  'editor.readSelection': { params: Empty; result: SelectionSnapshot };
  'commands.register': {
    params: { id: string; title: string; handler: number };
    result: { registrationId: string };
  };
  'commands.unregister': { params: { registrationId: string }; result: Empty };
  'diagnostics.publish': { params: RevisionTarget & { items: Diagnostic[] }; result: Empty };
  'diagnostics.clear': { params: Empty; result: Empty };
  'editor.proposeEdit': {
    params: RevisionTarget & { proposedText: string; explanation: string };
    result: { proposalId: string; outcome: 'pending-review' };
  };
}

export type BrokerMethod = keyof BrokerMethods;
export type BrokerErrorCode =
  | 'PERMISSION_DENIED' | 'STALE_SESSION' | 'STALE_REVISION' | 'INVALID_REQUEST'
  | 'QUOTA' | 'UNAVAILABLE' | 'HOST_FAILURE' | 'AUDIT_UNAVAILABLE';

export type BrokerRequest<M extends BrokerMethod = BrokerMethod> = {
  [K in M]: { protocol: 1; requestId: string; method: K; params: BrokerMethods[K]['params'] };
}[M];

export type BrokerResponse<M extends BrokerMethod> =
  | { protocol: 1; requestId: string; ok: true; result: BrokerMethods[M]['result'] }
  | { protocol: 1; requestId: string | null; ok: false; error: { code: BrokerErrorCode; message: string } };
