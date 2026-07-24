import type { DetailedHTMLProps, HTMLAttributes } from "react";
import type { PdfjsViewerElement } from "pdfjs-viewer-element";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "pdfjs-viewer-element": DetailedHTMLProps<
        HTMLAttributes<PdfjsViewerElement>,
        PdfjsViewerElement
      > & {
        src?: string;
        page?: string;
        zoom?: string;
        pagemode?: "thumbs" | "bookmarks" | "attachments" | "layers" | "none";
        "iframe-title"?: string;
        "viewer-css-theme"?: "AUTOMATIC" | "LIGHT" | "DARK";
        "worker-src"?: string;
        "c-map-url"?: string;
        "icc-url"?: string;
        "image-resources-path"?: string;
        "sandbox-bundle-src"?: string;
        "standard-font-data-url"?: string;
        "wasm-url"?: string;
      };
    }
  }
}

export {};
