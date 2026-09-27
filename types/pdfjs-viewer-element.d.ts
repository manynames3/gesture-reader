declare module "pdfjs-viewer-element" {
  export interface PdfjsViewerElement extends HTMLElement {
    iframe?: HTMLIFrameElement;
    initPromise: Promise<{ viewerApp?: unknown }>;
    injectViewerStyles(css: string): Promise<void>;
    setViewerOptions(options: Record<string, string | number | boolean>): Promise<{
      viewerOptions: {
        set(name: string, value: string | number | boolean): void;
        getAll(): Record<string, unknown>;
      };
    }>;
  }
}
