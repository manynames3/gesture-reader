const { contextBridge, ipcRenderer } = require("electron");

async function invoke(channel, ...args) {
  try {
    return await ipcRenderer.invoke(channel, ...args);
  } catch (error) {
    // Electron adds transport details to main-process errors. Keep the useful
    // message without presenting internal IPC channel names as product copy.
    const prefix = `Error invoking remote method '${channel}': Error: `;
    const message = typeof error?.message === "string"
      ? error.message : "The desktop library request could not finish. Try again.";
    throw new Error(message.startsWith(prefix) ? message.slice(prefix.length) : message);
  }
}

contextBridge.exposeInMainWorld("gestureReaderDesktop", {
  isDesktop: true,
  onAddPdfs: (listener) => {
    if (typeof listener !== "function") throw new TypeError("Expected a listener.");
    // Never expose Electron's event object or arbitrary channel access.
    const handle = () => listener();
    ipcRenderer.on("app:add-pdfs", handle);
    return () => ipcRenderer.removeListener("app:add-pdfs", handle);
  },
  list: () => invoke("library:list"),
  pickAndImport: () => invoke("library:pick-and-import"),
  importBytes: (files) => invoke("library:import-bytes", files),
  open: (id) => invoke("library:open", id),
  saveDocument: (record) =>
    invoke("library:save-document", record),
  saveReadingState: (id, state) =>
    invoke("library:save-reading-state", id, state),
  remove: (id) => invoke("library:remove", id),
  storageEstimate: () => invoke("library:storage-estimate"),
});
