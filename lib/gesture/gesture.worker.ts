/// <reference lib="webworker" />

import {
  FilesetResolver,
  GestureRecognizer,
  type GestureRecognizerResult,
} from "@mediapipe/tasks-vision";
import type { GestureSensitivity } from "@/lib/types";
import { SwipeDetector } from "./swipeDetector";

type WorkerRequest =
  | {
      type: "initialize";
      sensitivity: GestureSensitivity;
    }
  | {
      type: "frame";
      bitmap: ImageBitmap;
      timestamp: number;
    }
  | {
      type: "settings";
      sensitivity: GestureSensitivity;
    }
  | { type: "reset" }
  | { type: "dispose" };

type WorkerResponse =
  | { type: "ready" }
  | {
      type: "frameDone";
      confidence: number;
      state: string;
      handPresent: boolean;
      armProgress: number;
    }
  | {
      type: "gesture";
      direction: "left" | "right";
      confidence: number;
    }
  | { type: "error"; message: string };

let recognizer: GestureRecognizer | undefined;
const detector = new SwipeDetector();

function post(message: WorkerResponse) {
  self.postMessage(message);
}

function assetUrl(path: string) {
  return new URL(path, self.location.href).href;
}

function extractPalm(result: GestureRecognizerResult, timestamp: number) {
  const gesture = result.gestures[0]?.find(
    (candidate) => candidate.categoryName === "Open_Palm",
  );
  const landmarks = result.landmarks[0];
  const open = gesture?.categoryName === "Open_Palm";
  const confidence = open ? gesture.score : 0;
  if (!landmarks?.length) {
    return {
      timestamp,
      x: 0.5,
      y: 0.5,
      confidence: 0,
      open: false,
      handPresent: false,
    };
  }

  const palmIndices = [0, 5, 9, 13, 17];
  const palm = palmIndices.reduce(
    (total, index) => ({
      x: total.x + landmarks[index].x,
      y: total.y + landmarks[index].y,
    }),
    { x: 0, y: 0 },
  );

  return {
    timestamp,
    x: 1 - palm.x / palmIndices.length,
    y: palm.y / palmIndices.length,
    confidence,
    open,
    handPresent: true,
  };
}

async function initialize(sensitivity: GestureSensitivity) {
  detector.setSensitivity(sensitivity);
  const wasm = await FilesetResolver.forVisionTasks(
    assetUrl("/vendor/mediapipe/0.10.35/wasm"),
    true,
  );
  recognizer = await GestureRecognizer.createFromOptions(wasm, {
    baseOptions: {
      modelAssetPath: assetUrl(
        "/vendor/mediapipe/models/gesture-recognizer-float16-v1.task",
      ),
      delegate: "CPU",
    },
    canvas: new OffscreenCanvas(640, 480),
    runningMode: "VIDEO",
    numHands: 1,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
    cannedGesturesClassifierOptions: {
      categoryAllowlist: ["Open_Palm"],
      // Return the score even below the activation threshold so setup can
      // explain why a visible hand has not armed yet. SwipeDetector still
      // requires confidence >= 0.70.
      scoreThreshold: 0,
      maxResults: 1,
    },
  });
  post({ type: "ready" });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "initialize") {
      await initialize(message.sensitivity);
      return;
    }
    if (message.type === "settings") {
      detector.setSensitivity(message.sensitivity);
      return;
    }
    if (message.type === "reset") {
      detector.reset();
      return;
    }
    if (message.type === "dispose") {
      recognizer?.close();
      recognizer = undefined;
      close();
      return;
    }
    if (message.type === "frame") {
      if (!recognizer) {
        message.bitmap.close();
        post({
          type: "frameDone",
          confidence: 0,
          state: "idle",
          handPresent: false,
          armProgress: 0,
        });
        return;
      }

      try {
        const result = recognizer.recognizeForVideo(
          message.bitmap,
          message.timestamp,
        );
        const sample = extractPalm(result, message.timestamp);
        const detection = detector.push(sample);
        if (detection) {
          post({ type: "gesture", ...detection });
        }
        post({
          type: "frameDone",
          confidence: sample.confidence,
          state: detector.getState(message.timestamp),
          handPresent: sample.handPresent,
          armProgress: detector.getArmProgress(),
        });
      } finally {
        message.bitmap.close();
      }
    }
  } catch (error) {
    post({
      type: "error",
      message:
        error instanceof Error
          ? error.message
          : "Hand tracking could not start.",
    });
  }
};

export {};
