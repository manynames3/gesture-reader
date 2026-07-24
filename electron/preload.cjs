const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gestureReaderDesktop", {
  isDesktop: true,
  list: () => ipcRenderer.invoke("library:list"),
  pickAndImport: () => ipcRenderer.invoke("library:pick-and-import"),
  importBytes: (files) => ipcRenderer.invoke("library:import-bytes", files),
  open: (id) => ipcRenderer.invoke("library:open", id),
  saveDocument: (record) =>
    ipcRenderer.invoke("library:save-document", record),
  saveReadingState: (id, state) =>
    ipcRenderer.invoke("library:save-reading-state", id, state),
  remove: (id) => ipcRenderer.invoke("library:remove", id),
  storageEstimate: () => ipcRenderer.invoke("library:storage-estimate"),
});
