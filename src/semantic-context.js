export function createSemanticContext({ api, getActive, getDocuments, available, onChanged }) {
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

  function draftSnapshots(exclude) {
    const buffers = [];
    for (const tab of getDocuments()) {
      if (tab !== exclude && tab.language && tab.dirty) buffers.push(snapshot(tab));
    }
    return buffers;
  }

  return {
    available,
    draftSnapshots,
    changed() { generation++; onChanged(); },
    typeCheck(tab) {
      return api.typeCheck(tab.projectId, tab.path, [snapshot(tab), ...draftSnapshots(tab)]);
    },
    query(operation, tab, position, requestId) {
      const epoch = generation;
      const version = tab.version;
      const buffers = [snapshot(tab), ...draftSnapshots(tab)];
      return {
        result: api[operation](tab.projectId, tab.path, position, buffers, requestId),
        current: () => epoch === generation && tab.version === version && available() && getActive() === tab,
      };
    },
  };
}
