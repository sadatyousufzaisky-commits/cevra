export function createSemanticContext({ api, getActive, getDocuments, available }) {
  const snapshots = new WeakMap();
  let generation = 0;

  function snapshot(tab) {
    const doc = tab.state.doc;
    let cached = snapshots.get(tab);
    if (cached?.doc !== doc) {
      cached = { doc, text: doc.toString() };
      snapshots.set(tab, cached);
    }
    return { path: tab.path, documentId: tab.id, version: tab.version, text: cached.text };
  }

  return {
    available,
    changed() { generation++; },
    query(operation, tab, position, requestId) {
      const epoch = generation;
      const version = tab.version;
      const buffers = [snapshot(tab)];
      for (const other of getDocuments()) {
        if (other !== tab && other.language && other.dirty) buffers.push(snapshot(other));
      }
      return {
        result: api[operation](tab.projectId, tab.path, position, buffers, requestId),
        current: () => epoch === generation && tab.version === version && available() && getActive() === tab,
      };
    },
  };
}
