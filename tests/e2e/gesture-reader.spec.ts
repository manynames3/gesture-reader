import { expect, test } from "@playwright/test";
import { writePdfFixture } from "./pdfFixture";

test.describe("Gesture Reader", () => {
  let pdfPath: string;
  const documentTitle = "Gesture Reader E2E Guide";

  async function expectWorkspaceFillsViewport(
    page: import("@playwright/test").Page,
    includeGesturePanel = false,
  ) {
    await expect
      .poll(() =>
        page.evaluate((checkPanel) => {
          const workspace = document.querySelector(".reader-workspace");
          const stage = document.querySelector(".pdf-stage");
          const panel = checkPanel
            ? document.querySelector(".gesture-panel")
            : null;
          if (!workspace || !stage || (checkPanel && !panel)) {
            return Number.POSITIVE_INFINITY;
          }
          const bottoms = [
            workspace.getBoundingClientRect().bottom,
            stage.getBoundingClientRect().bottom,
            ...(panel ? [panel.getBoundingClientRect().bottom] : []),
          ];
          return Math.max(
            ...bottoms.map((bottom) => Math.abs(window.innerHeight - bottom)),
          );
        }, includeGesturePanel),
      )
      .toBeLessThanOrEqual(1);
  }

  test.beforeAll(async ({}, testInfo) => {
    pdfPath = await writePdfFixture(testInfo.project.outputDir);
  });

  test("imports, reads, searches, bookmarks, restores, and removes a PDF locally", async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (
        !["localhost", "127.0.0.1"].includes(url.hostname) &&
        !["blob:", "data:"].includes(url.protocol)
      ) {
        externalRequests.push(request.url());
      }
    });

    await page.goto("/");
    await expect(
      page.getByRole("heading", {
        name: "Turn the page. Keep your hands free.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Add a PDF to begin")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await expect(
      page.getByRole("button", {
        name: `Open ${documentTitle}`,
      }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await expect(
      page.getByText("That PDF is already in your library."),
    ).toBeVisible();

    await page
      .getByRole("button", { name: `Open ${documentTitle}` })
      .click();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    const viewer = page.frameLocator("pdfjs-viewer-element iframe");
    await expect(viewer.getByRole("button", { name: "Find" })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Print" })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Save" })).toBeVisible();
    await expect(
      viewer.getByText("Welcome to Gesture Reader"),
    ).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 1200 });
    await expectWorkspaceFillsViewport(page);

    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowRight");
    await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Bookmark current page" }).click();
    await expect(page.getByRole("button", { name: "1 saved" })).toBeVisible();
    await page.waitForTimeout(200);

    await page.getByRole("button", { name: "Back to library" }).click();
    await expect(
      page.getByRole("button", { name: `Open ${documentTitle}` }),
    ).toBeVisible();
    const storedReading = await page.evaluate(
      () =>
        new Promise<{ currentPage: number; bookmarks: number[] }>(
          (resolve, reject) => {
            const request = indexedDB.open("gesture-reader");
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const transaction = request.result.transaction(
                "documents",
                "readonly",
              );
              const records = transaction.objectStore("documents").getAll();
              records.onerror = () => reject(records.error);
              records.onsuccess = () =>
                resolve(records.result[0].reading);
            };
          },
        ),
    );
    expect(storedReading).toMatchObject({
      currentPage: 3,
      bookmarks: [3],
    });
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open("gesture-reader");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction(
              "documents",
              "readwrite",
            );
            const store = transaction.objectStore("documents");
            const records = store.getAll();
            records.onerror = () => reject(records.error);
            records.onsuccess = () => {
              const record = records.result[0];
              store.put({
                ...record,
                reading: {
                  ...record.reading,
                  zoom: "120000000000000%",
                },
              });
            };
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
          };
        }),
    );
    await page.reload();
    await page
      .getByRole("button", { name: `Open ${documentTitle}` })
      .click();
    await expect(page.getByText("Page 3 of 3", { exact: true })).toBeVisible();
    await expect(viewer.locator("#scaleSelect")).toHaveValue("custom");
    await expect(viewer.locator("#customScaleOption")).toContainText("120");
    await expect(viewer.locator("#customScaleOption")).not.toContainText(
      "120000",
    );
    await expect(
      page.getByRole("button", {
        name: "Remove bookmark from current page",
      }),
    ).toBeVisible();

    await page.waitForTimeout(700);
    await page.getByRole("button", { name: "Back to library" }).click();
    const repairedZoom = await page.evaluate(
      () =>
        new Promise<string>((resolve, reject) => {
          const request = indexedDB.open("gesture-reader");
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const transaction = request.result.transaction(
              "documents",
              "readonly",
            );
            const records = transaction.objectStore("documents").getAll();
            records.onerror = () => reject(records.error);
            records.onsuccess = () =>
              resolve(records.result[0].reading.zoom);
          };
        }),
    );
    expect(repairedZoom).toBe("1.2");
    await page
      .getByRole("button", {
        name: `Remove ${documentTitle} from library`,
      })
      .click();
    await expect(
      page.getByRole("dialog", { name: documentTitle }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ready when you are" }),
    ).toBeVisible();
    expect(externalRequests).toEqual([]);
  });

  test("uses a fake local camera, turns exactly one page, and releases tracks", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker;
      const workers: Array<{
        onmessage: ((event: MessageEvent) => void) | null;
      }> = [];
      const tracks: MediaStreamTrack[] = [];
      let resetCount = 0;
      let cameraRequestCount = 0;
      let holdCameraEnumeration = false;
      let releaseCameraEnumeration: (() => void) | undefined;
      let gestureFrame: {
        mode?: "palm" | "head";
        confidence?: number;
        state: string;
        handPresent?: boolean;
        armProgress?: number;
        facePresent?: boolean;
        rollDegrees?: number;
        neutralRollDegrees?: number;
        holdProgress?: number;
        holdDirection?: "left" | "right";
      } = {
        mode: "palm",
        confidence: 0,
        state: "idle",
        handPresent: false,
        armProgress: 0,
      };

      class GestureTestWorker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        onerror: ((event: ErrorEvent) => void) | null = null;
        private gestureWorker: boolean;
        private native?: Worker;

        constructor(url: URL | string, options?: WorkerOptions) {
          this.gestureWorker = String(url).includes("gesture.worker");
          if (!this.gestureWorker) {
            this.native = new NativeWorker(url, options);
            this.native.onmessage = (event) => this.onmessage?.(event);
            this.native.onerror = (event) => this.onerror?.(event);
          } else {
            workers.push(this);
          }
        }

        postMessage(message: unknown, transfer?: Transferable[]) {
          if (!this.gestureWorker) {
            this.native?.postMessage(message, transfer ?? []);
            return;
          }
          const request = message as {
            type?: string;
            bitmap?: ImageBitmap;
          };
          if (
            request.type === "initialize" ||
            request.type === "settings"
          ) {
            setTimeout(
              () =>
                this.onmessage?.(
                  new MessageEvent("message", { data: { type: "ready" } }),
                ),
              0,
            );
          } else if (request.type === "frame") {
            request.bitmap?.close();
            this.onmessage?.(
              new MessageEvent("message", {
                data: {
                  type: "frameDone",
                  ...gestureFrame,
                },
              }),
            );
          } else if (request.type === "reset") {
            resetCount += 1;
          }
        }

        terminate() {
          this.native?.terminate();
        }

        addEventListener() {}
        removeEventListener() {}
        dispatchEvent() {
          return true;
        }
      }

      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          async getUserMedia() {
            cameraRequestCount += 1;
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 480;
            const context = canvas.getContext("2d");
            context?.fillRect(0, 0, canvas.width, canvas.height);
            const stream = canvas.captureStream(20);
            const track = stream.getVideoTracks()[0];
            if (track) {
              Object.defineProperty(track, "getSettings", {
                configurable: true,
                value: () => ({
                  deviceId: "fake-desk-camera",
                  width: 640,
                  height: 480,
                }),
              });
              tracks.push(track);
            }
            return stream;
          },
          async enumerateDevices() {
            if (holdCameraEnumeration) {
              await new Promise<void>((resolve) => {
                releaseCameraEnumeration = resolve;
              });
            }
            return [
              {
                deviceId: "fake-desk-camera",
                groupId: "local",
                kind: "videoinput",
                label: "Fake desk camera",
                toJSON() {
                  return this;
                },
              },
            ];
          },
          addEventListener() {},
          removeEventListener() {},
        },
      });

      Object.assign(window, {
        __gestureTracks: tracks,
        __gestureResetCount() {
          return resetCount;
        },
        __cameraRequestCount() {
          return cameraRequestCount;
        },
        __disconnectGestureCamera() {
          const track = tracks.at(-1);
          track?.stop();
          track?.dispatchEvent(new Event("ended"));
        },
        __holdCameraEnumeration() {
          holdCameraEnumeration = true;
        },
        __releaseCameraEnumeration() {
          holdCameraEnumeration = false;
          releaseCameraEnumeration?.();
          releaseCameraEnumeration = undefined;
        },
        __installGestureWorker() {
          Object.defineProperty(window, "Worker", {
            configurable: true,
            value: GestureTestWorker,
          });
        },
        __emitGesture(direction: "left" | "right") {
          const worker = workers.at(-1);
          worker?.onmessage?.(
            new MessageEvent("message", {
              data: {
                type: "gesture",
                direction,
                confidence: 0.94,
              },
            }),
          );
        },
        __emitGestureWorkerError() {
          const worker = workers.at(-1);
          worker?.onmessage?.(
            new MessageEvent("message", {
              data: {
                type: "error",
                message: "Synthetic hand-tracking failure",
              },
            }),
          );
        },
        __setGestureFrame(next: typeof gestureFrame) {
          gestureFrame = next;
          const worker = workers.at(-1);
          worker?.onmessage?.(
            new MessageEvent("message", {
              data: { type: "frameDone", ...gestureFrame },
            }),
          );
        },
      });
    });

    await page.goto("/");
    await expect(page.getByText("Add a PDF to begin")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page
      .getByRole("button", { name: `Open ${documentTitle}` })
      .click();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __installGestureWorker(): void;
        }
      ).__installGestureWorker();
    });
    await page.getByRole("button", { name: "Enable gestures" }).click();
    await expect(
      page.getByRole("heading", { name: "Gesture setup" }),
    ).toBeVisible();
    await expect(
      page.getByText(/Raise your open palm into view|Palm locked — swipe now/),
    ).toBeVisible();
    await expect(
      page.getByLabel("Camera", { exact: true }),
    ).toHaveValue("fake-desk-camera");
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __cameraRequestCount(): number;
            }
          ).__cameraRequestCount(),
      ),
    ).toBe(1);

    await page.getByRole("button", { name: "Start calibration" }).click();
    await expect(
      page.getByText("Raise your whole open palm into view"),
    ).toBeVisible();
    const resetCountAfterStart = await page.evaluate(
      () =>
        (
          window as unknown as {
            __gestureResetCount(): number;
          }
        ).__gestureResetCount(),
    );
    await page.getByRole("button", { name: "Restart" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __gestureResetCount(): number;
              }
            ).__gestureResetCount(),
        ),
      )
      .toBe(resetCountAfterStart + 1);

    await page.evaluate(() => {
      (
        window as unknown as {
          __setGestureFrame(frame: {
            confidence: number;
            state: string;
            handPresent: boolean;
            armProgress: number;
          }): void;
        }
      ).__setGestureFrame({
        confidence: 0.55,
        state: "idle",
        handPresent: true,
        armProgress: 0,
      });
    });
    await expect(
      page.getByText("Spread your fingers and hold still"),
    ).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __setGestureFrame(frame: {
            confidence: number;
            state: string;
            handPresent: boolean;
            armProgress: number;
          }): void;
        }
      ).__setGestureFrame({
        confidence: 0.91,
        state: "armed",
        handPresent: true,
        // Guard against an inconsistent/stale progress value from the worker:
        // an armed snapshot must always render as a complete palm lock.
        armProgress: 0,
      });
    });
    await expect(
      page.getByText("Palm ready — swipe left"),
    ).toBeVisible();
    await expect(page.getByText("3/3 lock")).toBeVisible();

    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("right");
    });
    await expect(
      page.getByText(/A right swipe was detected/),
    ).toBeVisible();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();

    await page.getByLabel("Reverse page-turn direction").check();
    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("left");
    });
    await expect(
      page.getByText("Palm ready — swipe right"),
    ).toBeVisible();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();

    await page.evaluate(() => {
      (
        window as unknown as {
          __setGestureFrame(frame: {
            confidence: number;
            state: string;
            handPresent: boolean;
            armProgress: number;
          }): void;
        }
      ).__setGestureFrame({
        confidence: 0.91,
        state: "cooldown",
        handPresent: true,
        armProgress: 3,
      });
    });
    await expect(
      page.getByText("Lower your hand briefly to reset"),
    ).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __setGestureFrame(frame: {
            confidence: number;
            state: string;
            handPresent: boolean;
            armProgress: number;
          }): void;
        }
      ).__setGestureFrame({
        confidence: 0.91,
        state: "armed",
        handPresent: true,
        armProgress: 3,
      });
    });
    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("right");
    });
    await expect(
      page.getByText("Both directions are ready"),
    ).toBeVisible();
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Finish" }).click();
    await page.getByLabel("Reverse page-turn direction").uncheck();

    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("left");
    });
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();

    await page.waitForTimeout(350);
    const cameraRequestsBeforeHeadMode = await page.evaluate(
      () =>
        (
          window as unknown as {
            __cameraRequestCount(): number;
          }
        ).__cameraRequestCount(),
    );
    await page.getByRole("button", { name: "Head tilt" }).click();
    await expect(page.getByText("Center your face in view")).toBeVisible();
    expect(
      await page.evaluate(
        () =>
          (
            window as unknown as {
              __cameraRequestCount(): number;
            }
          ).__cameraRequestCount(),
      ),
    ).toBe(cameraRequestsBeforeHeadMode);

    await page.evaluate(() => {
      (
        window as unknown as {
          __setGestureFrame(frame: {
            mode: "head";
            state: string;
            facePresent: boolean;
            rollDegrees: number;
            neutralRollDegrees: number;
            holdProgress: number;
          }): void;
        }
      ).__setGestureFrame({
        mode: "head",
        state: "calibrating",
        facePresent: true,
        rollDegrees: 2,
        neutralRollDegrees: 0,
        holdProgress: 0.5,
      });
    });
    await expect(page.getByText("Look straight ahead — 50%")).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __setGestureFrame(frame: {
            mode: "head";
            state: string;
            facePresent: boolean;
            rollDegrees: number;
            neutralRollDegrees: number;
            holdProgress: number;
            holdDirection: "left";
          }): void;
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__setGestureFrame({
        mode: "head",
        state: "holding",
        facePresent: true,
        rollDegrees: -14,
        neutralRollDegrees: 0,
        holdProgress: 0.7,
        holdDirection: "left",
      });
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("left");
    });
    await expect(page.getByText("Page 1 of 3", { exact: true })).toBeVisible();
    await page.waitForTimeout(350);
    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("right");
    });
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Palm swipe" }).click();

    const requestCountBeforeDisconnect = await page.evaluate(
      () =>
        (
          window as unknown as {
            __cameraRequestCount(): number;
          }
        ).__cameraRequestCount(),
    );
    await page.evaluate(() => {
      (
        window as unknown as {
          __disconnectGestureCamera(): void;
        }
      ).__disconnectGestureCamera();
    });
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __cameraRequestCount(): number;
              }
            ).__cameraRequestCount(),
        ),
      )
      .toBe(requestCountBeforeDisconnect + 1);
    await expect(page.getByText("Camera active")).toBeVisible();

    await page.getByRole("button", { name: "0 saved" }).click();
    await expect(page.getByText("Page bookmarks")).toBeVisible();
    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("left");
    });
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "0 saved" }).click();

    await page.setViewportSize({ width: 1440, height: 1200 });
    await expectWorkspaceFillsViewport(page, true);

    await page.evaluate(() => {
      (
        window as unknown as {
          __emitGesture(direction: "left" | "right"): void;
        }
      ).__emitGesture("left");
    });
    await expect(page.getByText("Page 2 of 3", { exact: true })).toBeVisible();
    await expect(page.locator(".camera-frame__status")).not.toContainText(
      "Paused",
    );

    await page.evaluate(() => {
      window.dispatchEvent(new Event("blur"));
      (
        window as unknown as {
          __emitGestureWorkerError(): void;
        }
      ).__emitGestureWorkerError();
      window.dispatchEvent(new Event("focus"));
    });
    await expect(
      page.getByText("Camera needs attention").first(),
    ).toBeVisible();

    await page.getByRole("button", { name: "Gesture controls" }).click();
    await expect(page.getByText("Camera active")).toBeVisible();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as {
            __gestureTracks: MediaStreamTrack[];
          }
        ).__gestureTracks.some((track) => track.readyState === "live"),
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Gesture controls" }).click();
    await page.getByRole("button", { name: "Turn off gestures" }).click();
    await expect(page.getByText("Camera active")).toBeHidden();
    expect(
      await page.evaluate(() =>
        (
          window as unknown as {
            __gestureTracks: MediaStreamTrack[];
          }
        ).__gestureTracks.every((track) => track.readyState === "ended"),
      ),
    ).toBe(true);

    await page.evaluate(() => {
      (
        window as unknown as {
          __holdCameraEnumeration(): void;
        }
      ).__holdCameraEnumeration();
    });
    const requestsBeforeCancelledStart = await page.evaluate(
      () =>
        (
          window as unknown as {
            __cameraRequestCount(): number;
          }
        ).__cameraRequestCount(),
    );
    await page.getByRole("button", { name: "Enable gestures" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __cameraRequestCount(): number;
              }
            ).__cameraRequestCount(),
        ),
      )
      .toBe(requestsBeforeCancelledStart + 1);
    await page.getByRole("button", { name: "Turn off gestures" }).click();
    await page.evaluate(() => {
      (
        window as unknown as {
          __releaseCameraEnumeration(): void;
        }
      ).__releaseCameraEnumeration();
    });
    await expect(page.getByText("Camera active")).toBeHidden();
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            window as unknown as {
              __gestureTracks: MediaStreamTrack[];
            }
          ).__gestureTracks.every((track) => track.readyState === "ended"),
        ),
      )
      .toBe(true);
  });

  test("loads the bundled face model and processes local camera frames", async ({
    page,
  }) => {
    test.slow();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {
          async getUserMedia() {
            const canvas = document.createElement("canvas");
            canvas.width = 640;
            canvas.height = 480;
            const context = canvas.getContext("2d");
            if (context) {
              context.fillStyle = "#161914";
              context.fillRect(0, 0, canvas.width, canvas.height);
              let frame = 0;
              window.setInterval(() => {
                frame += 1;
                context.fillStyle =
                  frame % 2 === 0 ? "#161914" : "#171a15";
                context.fillRect(0, 0, canvas.width, canvas.height);
              }, 50);
            }
            const stream = canvas.captureStream(20);
            const track = stream.getVideoTracks()[0];
            if (track) {
              Object.defineProperty(track, "getSettings", {
                configurable: true,
                value: () => ({
                  deviceId: "local-head-model-camera",
                  width: 640,
                  height: 480,
                }),
              });
            }
            return stream;
          },
          async enumerateDevices() {
            return [
              {
                deviceId: "local-head-model-camera",
                groupId: "local",
                kind: "videoinput",
                label: "Local head model camera",
                toJSON() {
                  return this;
                },
              },
            ];
          },
          addEventListener() {},
          removeEventListener() {},
        },
      });
    });

    await page.goto("/");
    await expect(page.getByText("Add a PDF to begin")).toBeVisible();
    await page.locator('input[type="file"]').setInputFiles(pdfPath);
    await page
      .getByRole("button", { name: `Open ${documentTitle}` })
      .click();
    await page.getByRole("button", { name: "Enable gestures" }).click();
    await page.getByRole("button", { name: "Head tilt" }).click();

    await expect(
      page.getByText("Center your face in view"),
    ).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(
        async () => {
          const text = await page
            .locator(".gesture-metrics span")
            .first()
            .textContent();
          return Number.parseInt(text ?? "0", 10);
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);
    await expect(page.getByText("Camera needs attention")).toBeHidden();
  });
});
