const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
} = require("electron");
const { readFile, stat } = require("node:fs/promises");
const { Readable } = require("node:stream");
const path = require("node:path");
const { createDesktopLibrary } = require("./library.cjs");

const APP_ORIGIN = "gesture-reader://app";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "gesture-reader",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
      serviceWorkers: false,
    },
  },
]);

let mainWindow;
let library;

function isTrustedUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "gesture-reader:" && url.host === "app";
  } catch {
    return false;
  }
}

function assertTrustedEvent(event) {
  if (!isTrustedUrl(event.senderFrame?.url || event.sender.getURL())) {
    throw new Error("Untrusted application request.");
  }
}

function mimeType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".mjs": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".wasm": "application/wasm",
      ".task": "application/octet-stream",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webp": "image/webp",
      ".gif": "image/gif",
      ".woff2": "font/woff2",
    }[extension] || "application/octet-stream"
  );
}

function rendererRoot() {
  return path.join(app.getAppPath(), "dist", "client");
}

async function serveRenderer(requestUrl) {
  const url = new URL(requestUrl);
  let relative = decodeURIComponent(url.pathname);
  if (relative === "/" || relative.endsWith("/")) relative += "index.html";
  relative = relative.replace(/^\/+/, "");
  const root = rendererRoot();
  let resolved = path.resolve(root, relative);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    return new Response("Forbidden", { status: 403 });
  }
  try {
    const fileStat = await stat(resolved);
    if (fileStat.isDirectory()) resolved = path.join(resolved, "index.html");
  } catch {
    if (!path.extname(relative)) resolved = path.join(root, "index.html");
  }
  try {
    const body = await readFile(resolved);
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": mimeType(resolved),
        "Cache-Control": relative.startsWith("assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      },
    });
  } catch {
    return new Response("Not found", { status: 404 });
  }
}

async function handleProtocol(request) {
  const url = new URL(request.url);
  if (url.host !== "app") return new Response("Forbidden", { status: 403 });
  const match = /^\/__library\/([0-9a-f-]{36})$/i.exec(url.pathname);
  if (!match) return serveRenderer(request.url);
  if (!["GET", "HEAD"].includes(request.method)) {
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }

  try {
    const range = await library.readRange(
      match[1],
      request.headers.get("range"),
    );
    const headers = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/pdf",
      "Content-Length": String(range.length),
      "Cache-Control": "private, no-store",
    };
    if (range.partial) {
      headers["Content-Range"] =
        `bytes ${range.start}-${range.end}/${range.total}`;
    }
    // Measure queue capacity in bytes, not chunks. A default chunk-count
    // strategy could otherwise queue thousands of 64 KiB disk reads.
    const body = request.method === "HEAD" ? null : Readable.toWeb(range.stream, {
      strategy: { highWaterMark: 64 * 1024, size: (chunk) => chunk.byteLength },
    });
    if (!body) range.stream.destroy();
    return new Response(body, {
      status: range.partial ? 206 : 200,
      headers,
    });
  } catch (error) {
    if (error?.code === "ERR_PDF_RANGE") {
      return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${error.total}` } });
    }
    return new Response("PDF not found", { status: 404 });
  }
}

function registerLibraryIpc() {
  const handle = (channel, operation) => {
    ipcMain.handle(channel, async (event, ...args) => {
      assertTrustedEvent(event);
      return operation(...args);
    });
  };
  handle("library:list", () => library.list());
  handle("library:pick-and-import", () =>
    library.pickAndImport(mainWindow),
  );
  handle("library:import-bytes", (files) => library.importBytes(files));
  handle("library:open", async (id) => {
    await library.resolve(id);
    return `${APP_ORIGIN}/__library/${id}`;
  });
  handle("library:save-document", (record) => library.saveDocument(record));
  handle("library:save-reading-state", (id, state) =>
    library.saveReadingState(id, state),
  );
  handle("library:remove", (id) => library.remove(id));
  handle("library:storage-estimate", () => library.storageEstimate());
}

function configureSessionSecurity() {
  // Enforce local-only networking below the renderer CSP, including workers
  // and requests initiated through Chromium's session network stack.
  session.defaultSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => callback({
      cancel: !isTrustedUrl(details.url) &&
        !details.url.startsWith("blob:gesture-reader://app/") &&
        !details.url.startsWith("data:"),
    }),
  );
  const isVideoOnly = (permission, requestingOrigin, details = {}) => {
    if (permission !== "media" || !isTrustedUrl(requestingOrigin)) return false;
    const mediaTypes = Array.isArray(details.mediaTypes)
      ? details.mediaTypes
      : details.mediaType
        ? [details.mediaType]
        : [];
    return (
      mediaTypes.length === 0 ||
      (mediaTypes.includes("video") && !mediaTypes.includes("audio"))
    );
  };

  session.defaultSession.setPermissionCheckHandler(
    (_webContents, permission, requestingOrigin, details) =>
      isVideoOnly(permission, requestingOrigin, details),
  );
  session.defaultSession.setPermissionRequestHandler(
    (_webContents, permission, callback, details) => {
      const origin = details.requestingUrl || details.securityOrigin || "";
      callback(isVideoOnly(permission, origin, details));
    },
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 360,
    minHeight: 480,
    backgroundColor: "#0b0d0c",
    title: "Gesture Reader",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, navigationUrl) => {
    if (!isTrustedUrl(navigationUrl)) event.preventDefault();
  });
  const addPdfs = Menu.getApplicationMenu()?.getMenuItemById("add-pdfs");
  if (addPdfs) addPdfs.enabled = true;
  mainWindow.on("closed", () => {
    mainWindow = undefined;
    if (addPdfs) addPdfs.enabled = false;
  });
  void mainWindow.loadURL(`${APP_ORIGIN}/`);
}

function configureApplicationMenu() {
  app.setAboutPanelOptions({
    applicationName: "Gesture Reader",
    applicationVersion: app.getVersion(),
    credits: "Read PDFs with palm swipes or head tilts. Your library and camera processing stay on this device.",
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: [
      {
        id: "add-pdfs", label: "Add PDFs…", accelerator: "CmdOrCtrl+O",
        enabled: false,
        click: () => {
          if (mainWindow && !mainWindow.isDestroyed() && isTrustedUrl(mainWindow.webContents.getURL())) {
            mainWindow.webContents.send("app:add-pdfs");
          }
        },
      },
      { type: "separator" },
      { role: "close" },
    ] },
    { role: "editMenu" },
    { label: "View", submenu: [
      // Reload can discard unsaved reader state; development tools are not
      // part of the installed reading experience.
      ...(!app.isPackaged ? [
        { role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
      ] : []),
      { role: "resetZoom", label: "Actual Interface Size" },
      { role: "zoomIn", label: "Enlarge Interface" },
      { role: "zoomOut", label: "Reduce Interface" },
      { type: "separator" },
      { role: "togglefullscreen" },
    ] },
    { role: "windowMenu" },
  ]));
}

app.whenReady().then(async () => {
  library = createDesktopLibrary(app, dialog);
  protocol.handle("gesture-reader", handleProtocol);
  configureSessionSecurity();
  registerLibraryIpc();
  configureApplicationMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
