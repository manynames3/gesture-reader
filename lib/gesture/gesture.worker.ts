/// <reference lib="webworker" />

import {
  FaceLandmarker,
  FilesetResolver,
  GestureRecognizer,
  type GestureRecognizerResult,
} from "@mediapipe/tasks-vision";
import type {
  GestureInputMode,
  GestureSensitivity,
} from "@/lib/types";
import { HeadTiltDetector } from "./headTiltDetector";
import { extractHeadRoll } from "./headRoll";
import { palmLandmarksAreExtended } from "./palmGeometry";
import { SwipeDetector } from "./swipeDetector";

type WorkerRequest =
  | {
      type: "initialize";
      sensitivity: GestureSensitivity;
      mode: GestureInputMode;
    }
  | {
      type: "frame";
      bitmap: ImageBitmap;
      timestamp: number;
    }
  | {
      type: "settings";
      sensitivity: GestureSensitivity;
      mode: GestureInputMode;
    }
  | { type: "reset" }
  | { type: "dispose" };

type WorkerResponse =
  | { type: "ready" }
  | {
      type: "frameDone";
      mode: "palm";
      confidence: number;
      state: string;
      handPresent: boolean;
      armProgress: number;
    }
  | {
      type: "frameDone";
      mode: "head";
      state: string;
      facePresent: boolean;
      rollDegrees: number;
      neutralRollDegrees: number;
      holdProgress: number;
      holdDirection?: "left" | "right";
    }
  | {
      type: "gesture";
      source: "palmSwipe" | "headTilt";
      direction: "left" | "right";
      confidence: number;
    }
  | { type: "error"; message: string };

let gestureRecognizer: GestureRecognizer | undefined;
let faceLandmarker: FaceLandmarker | undefined;
let activeMode: GestureInputMode = "palm";
let initializationGeneration = 0;
let initializationQueue: Promise<void> = Promise.resolve();
const swipeDetector = new SwipeDetector();
const headTiltDetector = new HeadTiltDetector();

function post(message: WorkerResponse) {
  self.postMessage(message);
}

function assetUrl(path: string) {
  return new URL(path, self.location.href).href;
}

function clampUnit(value: number) {
  return Math.min(1, Math.max(0, value));
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
      palmExtended: false,
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
    x: clampUnit(1 - palm.x / palmIndices.length),
    y: clampUnit(palm.y / palmIndices.length),
    confidence,
    open,
    handPresent: true,
    // The classifier is the only signal allowed to arm. Once armed, landmark
    // geometry distinguishes an extended palm under motion blur from a fist.
    palmExtended: palmLandmarksAreExtended(landmarks),
  };
}

function closeRecognizers() {
  gestureRecognizer?.close();
  faceLandmarker?.close();
  gestureRecognizer = undefined;
  faceLandmarker = undefined;
}

function getWasm() {
  // MediaPipe consumes a module factory when a task is created. Resolve a
  // fresh fileset when switching task types; the browser still reuses the
  // locally cached WASM bytes.
  return FilesetResolver.forVisionTasks(
    assetUrl("/vendor/mediapipe/0.10.35/wasm"),
    true,
  );
}

function initialize(
  sensitivity: GestureSensitivity,
  mode: GestureInputMode,
) {
  const generation = ++initializationGeneration;
  activeMode = mode;
  swipeDetector.setSensitivity(sensitivity);
  headTiltDetector.setSensitivity(sensitivity);
  swipeDetector.reset();
  headTiltDetector.reset();
  const queued = initializationQueue
    .catch(() => undefined)
    .then(() => initializeForGeneration(mode, generation));
  initializationQueue = queued;
  return queued;
}

async function initializeForGeneration(
  mode: GestureInputMode,
  generation: number,
) {
  if (generation !== initializationGeneration) return;
  closeRecognizers();

  const wasm = await getWasm();
  if (generation !== initializationGeneration) return;

  if (mode === "palm") {
    const created = await GestureRecognizer.createFromOptions(wasm, {
      baseOptions: {
        modelAssetPath: assetUrl(
          "/vendor/mediapipe/models/gesture-recognizer-float16-v1.task",
        ),
        delegate: "CPU",
      },
      canvas: new OffscreenCanvas(640, 480),
      runningMode: "VIDEO",
      numHands: 1,
      minHandDetectionConfidence: 0.45,
      minHandPresenceConfidence: 0.4,
      minTrackingConfidence: 0.35,
      cannedGesturesClassifierOptions: {
        categoryAllowlist: ["Open_Palm"],
        // Return the score even below the activation threshold so setup can
        // explain why a visible hand has not armed yet. SwipeDetector applies
        // the threshold selected by Steady, Balanced, or Quick mode.
        scoreThreshold: 0,
        maxResults: 1,
      },
    });
    if (generation !== initializationGeneration) {
      created.close();
      return;
    }
    gestureRecognizer = created;
  } else {
    const created = await FaceLandmarker.createFromOptions(wasm, {
      baseOptions: {
        modelAssetPath: assetUrl(
          "/vendor/mediapipe/models/face-landmarker-float16-v1.task",
        ),
        delegate: "CPU",
      },
      canvas: new OffscreenCanvas(640, 480),
      runningMode: "VIDEO",
      numFaces: 1,
      minFaceDetectionConfidence: 0.5,
      minFacePresenceConfidence: 0.5,
      minTrackingConfidence: 0.45,
      outputFaceBlendshapes: false,
      outputFacialTransformationMatrixes: false,
    });
    if (generation !== initializationGeneration) {
      created.close();
      return;
    }
    faceLandmarker = created;
  }

  post({ type: "ready" });
}

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const message = event.data;
  try {
    if (message.type === "initialize") {
      await initialize(message.sensitivity, message.mode);
      return;
    }
    if (message.type === "settings") {
      if (message.mode !== activeMode) {
        await initialize(message.sensitivity, message.mode);
      } else if (message.mode === "palm") {
        swipeDetector.setSensitivity(message.sensitivity);
      } else {
        headTiltDetector.setSensitivity(message.sensitivity);
      }
      return;
    }
    if (message.type === "reset") {
      if (activeMode === "palm") {
        swipeDetector.reset();
      } else {
        headTiltDetector.reset();
      }
      return;
    }
    if (message.type === "dispose") {
      initializationGeneration += 1;
      closeRecognizers();
      close();
      return;
    }
    if (message.type === "frame") {
      if (
        (activeMode === "palm" && !gestureRecognizer) ||
        (activeMode === "head" && !faceLandmarker)
      ) {
        message.bitmap.close();
        if (activeMode === "palm") {
          post({
            type: "frameDone",
            mode: "palm",
            confidence: 0,
            state: "idle",
            handPresent: false,
            armProgress: 0,
          });
        } else {
          post({
            type: "frameDone",
            mode: "head",
            state: "calibrating",
            facePresent: false,
            rollDegrees: 0,
            neutralRollDegrees: 0,
            holdProgress: 0,
          });
        }
        return;
      }

      try {
        if (activeMode === "palm" && gestureRecognizer) {
          const result = gestureRecognizer.recognizeForVideo(
            message.bitmap,
            message.timestamp,
          );
          const sample = extractPalm(result, message.timestamp);
          const detection = swipeDetector.push(sample);
          if (detection) {
            post({
              type: "gesture",
              source: "palmSwipe",
              ...detection,
            });
          }
          post({
            type: "frameDone",
            mode: "palm",
            confidence: sample.confidence,
            state: swipeDetector.getState(message.timestamp),
            handPresent: sample.handPresent,
            armProgress: swipeDetector.getArmProgress(),
          });
        } else if (activeMode === "head" && faceLandmarker) {
          const result = faceLandmarker.detectForVideo(
            message.bitmap,
            message.timestamp,
          );
          const measurement = extractHeadRoll(result.faceLandmarks[0]);
          const detection = headTiltDetector.push({
            timestamp: message.timestamp,
            ...measurement,
          });
          if (detection) {
            post({
              type: "gesture",
              source: "headTilt",
              ...detection,
            });
          }
          const metrics = headTiltDetector.getMetrics(message.timestamp);
          post({
            type: "frameDone",
            mode: "head",
            state: metrics.state,
            facePresent: metrics.facePresent,
            rollDegrees: metrics.rollDegrees,
            neutralRollDegrees: metrics.neutralRollDegrees,
            holdProgress: metrics.progress,
            holdDirection: metrics.direction,
          });
        }
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
