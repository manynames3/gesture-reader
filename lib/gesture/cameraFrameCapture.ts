/** One capture session owns a reusable, unmirrored downsampling surface. */
export function createCameraFrameCapture(video: HTMLVideoElement) {
  let useCanvas = false;
  let canvas: HTMLCanvasElement | undefined;

  return async (): Promise<ImageBitmap> => {
    const scale = Math.min(1, 640 / Math.max(1, video.videoWidth), 480 / Math.max(1, video.videoHeight));
    const width = Math.max(1, Math.round(video.videoWidth * scale));
    const height = Math.max(1, Math.round(video.videoHeight * scale));
    if (!useCanvas) {
      try {
        const bitmap = await createImageBitmap(video, {
          resizeWidth: width, resizeHeight: height, resizeQuality: "medium",
        });
        if (bitmap.width === width && bitmap.height === height) return bitmap;
        // Some implementations accept but ignore bitmap resize options.
        bitmap.close();
      } catch {
        // Canvas capture also works where resizing a video bitmap is unsupported.
      }
      useCanvas = true;
    }
    canvas ??= document.createElement("canvas");
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Camera downsampling is unavailable.");
    context.drawImage(video, 0, 0, width, height);
    const bitmap = await createImageBitmap(canvas);
    if (bitmap.width !== width || bitmap.height !== height) {
      bitmap.close();
      throw new Error("Camera frame dimensions are invalid.");
    }
    return bitmap;
  };
}
