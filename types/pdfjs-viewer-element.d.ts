declare module "pdfjs-viewer-element" {
  export interface PdfjsViewerElement extends HTMLElement {
    iframe?: HTMLIFrameElement;
    initPromise: Promise<{ viewerApp?: unknown }>;
    injectViewerStyles(css: string): Promise<void>;
  }
}
