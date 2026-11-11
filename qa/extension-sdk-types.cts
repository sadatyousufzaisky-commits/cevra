import type { BrokerRequest, BrokerResponse, ExecutableManifest } from '../sdk/extensions/contracts.js';
import { validateManifest } from '../sdk/extensions/manifest.cjs';

const manifest = {
  schemaVersion: 2,
  id: 'org.cevra.examples.hello-command',
  version: '1.0.0',
  displayName: 'Hello Command',
  description: 'A scoped command example.',
  engines: { cevra: '>=0.1.0 <0.2.0' },
  runtime: { apiVersion: '0.1', entry: 'extension.wasm' },
  permissions: [{ capability: 'commands.register' }],
  contributes: {},
} satisfies ExecutableManifest;

const request: BrokerRequest = {
  protocol: 1, requestId: 'hello-1', method: 'commands.register',
  params: { id: 'say-hello', title: 'Say hello', handler: 0 },
};
const read: BrokerRequest<'workspace.readFile'> = {
  protocol: 1, requestId: 'read-1', method: 'workspace.readFile',
  params: { path: 'src/demo.js', source: 'disk' },
};
const response: BrokerResponse<'workspace.readFile'> = {
  protocol: 1, requestId: read.requestId, ok: false,
  error: { code: 'PERMISSION_DENIED', message: 'This operation was not granted.' },
};

// @ts-expect-error Unregister takes the opaque receipt, not the handler index.
const wrongParams: BrokerRequest = { ...request, method: 'commands.unregister', params: { handler: 0 } };
// @ts-expect-error The runtime descriptor must name a supported API.
const wrongApi: ExecutableManifest = { ...manifest, runtime: { ...manifest.runtime, apiVersion: '1.0' } };
// @ts-expect-error An edit proposal returns an ID and a pending-review outcome.
const wrongResult: BrokerResponse<'editor.proposeEdit'> = { protocol: 1, requestId: 'edit-1', ok: true, result: {} };
// @ts-expect-error The manifest validator accepts original bytes to detect duplicate keys.
validateManifest(manifest);

const validated = validateManifest(new Uint8Array());
if (validated.schemaVersion === 2) {
  const negotiated: '0.1' = validated.runtime.apiVersion;
}
