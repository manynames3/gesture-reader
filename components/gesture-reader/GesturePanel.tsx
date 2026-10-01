"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useShortGestureSetup } from "@/lib/ui/useShortGestureSetup";
import { BrowserGestureEngine } from "@/lib/gesture/browserGestureEngine";
import { createCameraFrameCapture } from "@/lib/gesture/cameraFrameCapture";
import { openPalmThresholdForSensitivity } from "@/lib/gesture/swipeDetector";
import type {
  GestureEvent,
  GestureInputMode,
  GestureSensitivity,
  GestureStatus,
  NavigationResult,
} from "@/lib/types";

interface GesturePanelProps {
  enabled: boolean;
  open: boolean;
  paused: boolean;
  navigationBusy: boolean;
  readerReady: boolean;
  wholePageFitted: boolean;
  onFitPage(): Promise<NavigationResult>;
  onDisable(): void;
  onClose(): void;
  onStatusChange(status: GestureStatus): void;
  onGesture(
    direction: "left" | "right",
    source: "palmSwipe" | "headTilt",
  ): Promise<NavigationResult>;
}

type CalibrationStep = "off" | "left" | "right" | "complete";

const statusCopy: Record<GestureStatus, string> = {
  off: "Camera off",
  requesting: "Waiting for permission",
  loading: "Loading gesture tracking",
  ready: "Ready for an open palm",
  hand: "Palm detected — swipe",
  head: "Head movement detected",
  cooldown: "Return your hand to its starting point",
  paused: "Paused",
  error: "Camera needs attention",
};

function loadPreference<T extends string | boolean | number>(key: string, fallback: T, allowed?: readonly T[]): T {
  try {
    const stored = localStorage.getItem(key);
    if (stored === null) return fallback;
    const value: unknown = JSON.parse(stored);
    if (typeof value !== typeof fallback || (typeof value === "number" && !Number.isFinite(value)) || (allowed && !allowed.includes(value as T))) return fallback;
    return value as T;
  } catch {
    return fallback;
  }
}

function savePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private browsing or a full storage area must not disable live controls.
  }
}

export function GesturePanel({
  enabled,
  open,
  paused,
  navigationBusy,
  readerReady,
  wholePageFitted,
  onFitPage,
  onDisable,
  onClose,
  onStatusChange,
  onGesture,
}: GesturePanelProps) {
  const shortSetup = useShortGestureSetup();
  const setupModal = shortSetup && open;
  const setupModalRef = useRef(setupModal);
  const panelRef = useRef<HTMLElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const engineRef = useRef<BrowserGestureEngine | null>(null);
  const calibrationRef = useRef<CalibrationStep>("off");
  const pausedRef = useRef(paused);
  const externalPausedRef = useRef(paused);
  const windowFocusedRef = useRef(true);
  const lastEngineStatusRef = useRef<GestureStatus>("off");
  const sensitivityRef = useRef<GestureSensitivity>("medium");
  const invertedRef = useRef(false);
  const onDisableRef = useRef(onDisable);
  const onGestureRef = useRef(onGesture);
  const turnFeedbackTimerRef =
    useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const turnFeedbackGenerationRef = useRef(0);
  const [status, setStatus] = useState<GestureStatus>("off");
  const [statusMessage, setStatusMessage] = useState("");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string>(() => typeof window === "undefined" ? "" : loadPreference<string>("gesture-reader:camera", ""));
  const [activeDeviceId, setActiveDeviceId] = useState("");
  const [cameraGeneration, setCameraGeneration] = useState(0);
  const [sensitivity, setSensitivity] = useState<GestureSensitivity>(() =>
    typeof window === "undefined"
      ? "medium"
      : loadPreference<GestureSensitivity>("gesture-reader:sensitivity", "medium", ["low", "medium", "high"]),
  );
  const [inputMode, setInputMode] = useState<GestureInputMode>(() =>
    typeof window === "undefined"
      ? "head"
      : loadPreference<GestureInputMode>("gesture-reader:input-mode", "head", ["palm", "head"]),
  );
  const modeRef = useRef<GestureInputMode>(inputMode);
  const [inverted, setInverted] = useState(() =>
    typeof window === "undefined"
      ? false
      : loadPreference<boolean>("gesture-reader:inverted", false),
  );
  const [showPreview, setShowPreview] = useState<boolean>(() => typeof window === "undefined" ? true : loadPreference<boolean>("gesture-reader:preview", true));
  const [headTiltDegrees, setHeadTiltDegrees] = useState(() => typeof window === "undefined" ? 12 : Math.min(25, Math.max(3, loadPreference("gesture-reader:head-tilt-degrees", 12))));
  const headTiltDegreesRef = useRef(headTiltDegrees);
  const [fps, setFps] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [handPresent, setHandPresent] = useState(false);
  const [, setArmProgress] = useState(0);
  const [facePresent, setFacePresent] = useState(false);
  const [rollDegrees, setRollDegrees] = useState(0);
  const [neutralRollDegrees, setNeutralRollDegrees] = useState(0);
  const [holdProgress, setHoldProgress] = useState(0);
  const [holdDirection, setHoldDirection] = useState<
    "left" | "right" | undefined
  >();
  const [headState, setHeadState] = useState<
    "calibrating" | "ready" | "holding" | "cooldown"
  >("calibrating");
  const [calibration, setCalibration] = useState<CalibrationStep>("off");
  const [calibrationFeedback, setCalibrationFeedback] = useState("");
  const [turnFeedback, setTurnFeedback] = useState("");
  const [fittingPage, setFittingPage] = useState(false);
  const [fitError, setFitError] = useState("");
  // Native Page Fit can also resolve a failed attempt; do not keep its obsolete error.
  if (wholePageFitted && fitError) setFitError("");

  useEffect(() => {
    onStatusChange(paused && enabled ? "paused" : status);
  }, [enabled, onStatusChange, paused, status]);

  // Camera events do not wait for passive effects. Update every event guard
  // before paint so the first gesture after a modal closes is not discarded.
  useLayoutEffect(() => {
    externalPausedRef.current = paused;
    pausedRef.current = paused || !windowFocusedRef.current;
    onDisableRef.current = onDisable;
    onGestureRef.current = onGesture;
    calibrationRef.current = calibration;
    setupModalRef.current = setupModal;
  }, [calibration, onDisable, onGesture, paused, setupModal]);

  useLayoutEffect(() => {
    // Do not carry a partially armed swipe/held tilt across setup boundaries.
    engineRef.current?.reset();
  }, [setupModal]);

  const clearTurnFeedback = useCallback(() => {
    turnFeedbackGenerationRef.current += 1;
    clearTimeout(turnFeedbackTimerRef.current);
    setTurnFeedback("");
  }, []);

  const endCalibration = useCallback(() => {
    calibrationRef.current = "off";
    setCalibration("off");
    setCalibrationFeedback("");
    engineRef.current?.reset();
    clearTurnFeedback();
  }, [clearTurnFeedback]);

  useEffect(() => {
    if (open) closeButtonRef.current?.focus({ preventScroll: true });
    else if (calibrationRef.current !== "off") endCalibration();
  }, [endCalibration, open, shortSetup]);

  const showTurnFeedback = useCallback(
    (message: string, clearAfter = 0) => {
      clearTimeout(turnFeedbackTimerRef.current);
      setTurnFeedback(message);
      if (clearAfter > 0) {
        turnFeedbackTimerRef.current = setTimeout(
          () => setTurnFeedback(""),
          clearAfter,
        );
      }
    },
    [],
  );

  useEffect(
    () => () => clearTimeout(turnFeedbackTimerRef.current),
    [],
  );

  useEffect(() => {
    savePreference("gesture-reader:sensitivity", sensitivity);
    sensitivityRef.current = sensitivity;
    engineRef.current?.updateSensitivity(sensitivity);
  }, [sensitivity]);

  useEffect(() => {
    savePreference("gesture-reader:inverted", inverted);
    invertedRef.current = inverted;
  }, [inverted]);

  useEffect(() => {
    headTiltDegreesRef.current = headTiltDegrees;
    savePreference("gesture-reader:head-tilt-degrees", headTiltDegrees);
    engineRef.current?.updateHeadTiltDegrees(headTiltDegrees);
  }, [headTiltDegrees]);

  useEffect(() => { savePreference("gesture-reader:camera", deviceId); }, [deviceId]);
  useEffect(() => { savePreference("gesture-reader:preview", showPreview); }, [showPreview]);

  const handleEngineEvent = useCallback(
    (event: GestureEvent) => {
      if (event.type === "status") {
        lastEngineStatusRef.current = event.status;
        if (!pausedRef.current) setStatus(event.status);
        setStatusMessage(event.message ?? "");
        if (event.status === "error" || event.status === "loading" || event.status === "off") {
          setFps(0);
          setConfidence(0);
          setHandPresent(false);
          setArmProgress(0);
          setFacePresent(false);
          setHoldProgress(0);
          setHoldDirection(undefined);
          setHeadState("calibrating");
        }
        return;
      }
      if (event.type === "metrics") {
        if (event.mode !== modeRef.current) return;
        lastEngineStatusRef.current = event.status;
        if (!pausedRef.current) setStatus(event.status);
        setFps(event.fps);
        setConfidence(event.confidence);
        setHandPresent(event.handPresent);
        setArmProgress(event.armProgress);
        setFacePresent(event.facePresent);
        setRollDegrees(event.rollDegrees);
        setNeutralRollDegrees(event.neutralRollDegrees);
        setHoldProgress(event.holdProgress);
        setHoldDirection(event.holdDirection);
        setHeadState(event.headState ?? "ready");
        return;
      }

      // Keep recognizing while PDF turns are pending. The command bus orders
      // every accepted turn; focus and interaction pauses still gate input.
      if (pausedRef.current) {
        return;
      }
      if (
        (modeRef.current === "palm" && event.source !== "palmSwipe") ||
        (modeRef.current === "head" && event.source !== "headTilt")
      ) {
        return;
      }

      const currentCalibration = calibrationRef.current;
      if (currentCalibration === "left") {
        if (event.direction === "left") {
          calibrationRef.current = "right";
          setCalibration("right");
          setCalibrationFeedback("");
        } else {
          setCalibrationFeedback(
            modeRef.current === "head"
              ? "A right tilt was detected. Return to center, then tilt left as it appears in the mirrored preview."
              : "A right swipe was detected. Move left as it appears in the mirrored preview.",
          );
        }
        return;
      }
      if (currentCalibration === "right") {
        if (event.direction === "right") {
          calibrationRef.current = "complete";
          setCalibration("complete");
          setCalibrationFeedback("");
        } else {
          setCalibrationFeedback(
            modeRef.current === "head"
              ? "A left tilt was detected. Return to center, then tilt right as it appears in the mirrored preview."
              : "A left swipe was detected. Move right as it appears in the mirrored preview.",
          );
        }
        return;
      }
      if (currentCalibration !== "off") return;
      // Keep live tracking available for practice, not hidden page turns.
      if (setupModalRef.current) return;

      const direction = invertedRef.current
        ? event.direction === "left"
          ? "right"
          : "left"
        : event.direction;
      const feedbackGeneration = turnFeedbackGenerationRef.current + 1;
      turnFeedbackGenerationRef.current = feedbackGeneration;
      showTurnFeedback(
        event.source === "headTilt"
          ? "Tilt detected — opening page…"
          : "Swipe detected — opening page…",
      );
      void onGestureRef
        .current(direction, event.source)
        .then((result) => {
          if (turnFeedbackGenerationRef.current !== feedbackGeneration) return;
          if (result.status === "confirmed") {
            showTurnFeedback(`Now on page ${result.to}`, 1_800);
          } else if (result.reason === "boundary") {
            showTurnFeedback("No page in that direction", 1_800);
          } else if (result.reason === "busy") {
            showTurnFeedback(
              "Finishing the last turn — reset and try again",
              1_800,
            );
          } else if (result.reason === "notReady") {
            showTurnFeedback("PDF still opening — reset and try again", 1_800);
          } else {
            showTurnFeedback("Page did not move — reset and try again", 1_800);
          }
        })
        .catch(() => {
          if (turnFeedbackGenerationRef.current !== feedbackGeneration) return;
          showTurnFeedback("Page did not move — reset and try again", 1_800);
        });
    },
    [showTurnFeedback],
  );

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let failed = false;
    let restartRequested = false;
    let animationFrame = 0;
    let videoFrameCallback = 0;
    let focusCheckTimer: ReturnType<typeof setTimeout> | undefined;
    let stream: MediaStream | undefined;
    let activeTrack: MediaStreamTrack | undefined;
    let currentStreamDeviceId = "";
    let lastFrameAt = 0;
    let lastFrameId: number | undefined;
    const engine = new BrowserGestureEngine();
    const preview = videoRef.current;
    const captureFrame = preview ? createCameraFrameCapture(preview) : undefined;
    engineRef.current = engine;
    const unsubscribe = engine.subscribe((event) => {
      handleEngineEvent(event);
      if (event.type === "status" && event.status === "error") {
        failed = true;
        activeTrack?.removeEventListener("ended", handleTrackEnded);
        stream?.getTracks().forEach((track) => track.stop());
        if (preview && preview.srcObject === stream) preview.srcObject = null;
      }
    });

    function fallbackFrameId(video: HTMLVideoElement) {
      const qualityFrames =
        video.getVideoPlaybackQuality?.().totalVideoFrames;
      if (qualityFrames && qualityFrames > 0) return qualityFrames;
      const decodedFrames = (
        video as HTMLVideoElement & {
          webkitDecodedFrameCount?: number;
        }
      ).webkitDecodedFrameCount;
      return decodedFrames && decodedFrames > 0
        ? decodedFrames
        : video.currentTime;
    }

    async function processVideoFrame(frameId: number, timestamp: number) {
      if (cancelled || failed) return;
      const video = preview;
      if (
        video &&
        video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        engine.canAcceptFrame() &&
        !pausedRef.current &&
        document.visibilityState === "visible" &&
        frameId !== lastFrameId &&
        timestamp - lastFrameAt >= 50
      ) {
        try {
          if (!captureFrame) return;
          const bitmap = await captureFrame();
          // Permission, focus or tracking can change while bitmap capture awaits.
          if (cancelled || failed || pausedRef.current || document.visibilityState !== "visible") {
            bitmap.close();
            return;
          }
          if (engine.submitFrame(bitmap, timestamp)) {
            lastFrameAt = timestamp;
            lastFrameId = frameId;
          }
        } catch {
          if (!cancelled && !failed) {
            failed = true;
            await discardStaleStart();
            lastEngineStatusRef.current = "error";
            setStatus("error");
            setStatusMessage(
              "This browser cannot pass camera frames to on-device gesture tracking. Try the camera again, or use the page buttons.",
            );
          }
        }
      }
    }

    function scheduleFrameCapture() {
      if (cancelled || failed || !preview) return;
      if (typeof preview.requestVideoFrameCallback === "function") {
        videoFrameCallback = preview.requestVideoFrameCallback(
          (timestamp, metadata) => {
            void processVideoFrame(
              metadata.presentedFrames,
              timestamp,
            ).finally(scheduleFrameCapture);
          },
        );
        return;
      }
      animationFrame = requestAnimationFrame((timestamp) => {
        void processVideoFrame(
          fallbackFrameId(preview),
          timestamp,
        ).finally(scheduleFrameCapture);
      });
    }

    async function discardStaleStart() {
      activeTrack?.removeEventListener("ended", handleTrackEnded);
      stream?.getTracks().forEach((track) => track.stop());
      if (preview && preview.srcObject === stream) preview.srcObject = null;
      await engine.stop();
    }

    async function start() {
      try {
        lastEngineStatusRef.current = "requesting";
        setStatus("requesting");
        setStatusMessage("");
        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error(
            "Camera access is unavailable here. Open Gesture Reader over HTTPS or use the macOS app.",
          );
        }
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: 640 },
            height: { ideal: 480 },
            frameRate: { ideal: 30, max: 30 },
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          },
        });
        if (cancelled) {
          await discardStaleStart();
          return;
        }

        const video = preview;
        if (!video) throw new Error("The camera preview is unavailable.");
        video.srcObject = stream;
        await video.play();
        if (cancelled) {
          await discardStaleStart();
          return;
        }
        const availableDevices =
          await navigator.mediaDevices.enumerateDevices().catch(() => []);
        if (cancelled) {
          await discardStaleStart();
          return;
        }
        const cameras = availableDevices.filter(
          (device) => device.kind === "videoinput",
        );
        setDevices(cameras);
        activeTrack = stream.getVideoTracks()[0];
        const activeId = activeTrack?.getSettings().deviceId;
        currentStreamDeviceId = activeId ?? deviceId;
        setActiveDeviceId(activeId ?? deviceId);
        activeTrack?.addEventListener("ended", handleTrackEnded);
        await engine.start({
          deviceId: activeId,
          sensitivity: sensitivityRef.current,
          mode: modeRef.current,
          inverted: invertedRef.current,
          showPreview: true,
          headTiltDegrees: headTiltDegreesRef.current,
        });
        if (cancelled) {
          await discardStaleStart();
          return;
        }
        scheduleFrameCapture();
      } catch (error) {
        if (!cancelled && deviceId && error instanceof DOMException && ["NotFoundError", "OverconstrainedError"].includes(error.name)) {
          requestCameraFallback();
          return;
        }
        failed = true;
        activeTrack?.removeEventListener("ended", handleTrackEnded);
        stream?.getTracks().forEach((track) => track.stop());
        if (preview && preview.srcObject === stream) {
          preview.srcObject = null;
        }
        await engine.stop();
        if (cancelled) return;
        const denied =
          error instanceof DOMException && error.name === "NotAllowedError";
        lastEngineStatusRef.current = "error";
        setStatus("error");
        setStatusMessage(
          denied
            ? "Camera access was denied. Allow it in your browser or Mac privacy settings, then try again."
            : error instanceof Error
              ? error.message
              : "No available camera could be started.",
        );
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "hidden") onDisableRef.current();
    }
    function handleBlur() {
      clearTimeout(focusCheckTimer);
      windowFocusedRef.current = false;
      pausedRef.current = true;
      setStatus("paused");
      // Entering PDF.js's iframe blurs the parent window too. Wait for the
      // browser's focus chain to settle before treating it as leaving the app.
      focusCheckTimer = setTimeout(() => {
        if (cancelled) return;
        if (document.hasFocus()) handleFocus();
        else engine.reset();
      }, 0);
    }
    function handleFocus() {
      clearTimeout(focusCheckTimer);
      windowFocusedRef.current = true;
      pausedRef.current = externalPausedRef.current;
      if (!externalPausedRef.current) {
        setStatus(lastEngineStatusRef.current);
      }
    }
    function requestCameraFallback() {
      if (cancelled || failed || restartRequested) return;
      restartRequested = true;
      setActiveDeviceId("");
      setStatusMessage(
        "The active camera disconnected. Switching to the default camera.",
      );
      if (deviceId) {
        setDeviceId("");
      } else {
        setCameraGeneration((current) => current + 1);
      }
    }
    function handleTrackEnded() {
      requestCameraFallback();
    }
    async function refreshDevices() {
      let available: MediaDeviceInfo[];
      try {
        available = await navigator.mediaDevices.enumerateDevices();
      } catch {
        if (!cancelled && !failed) {
          setStatusMessage(
            "The camera list could not be refreshed. The active camera is still connected.",
          );
        }
        return;
      }
      if (cancelled || failed) return;
      const cameras = available.filter(
        (device) => device.kind === "videoinput",
      );
      setDevices(cameras);
      if (
        currentStreamDeviceId &&
        !cameras.some(
          (device) => device.deviceId === currentStreamDeviceId,
        )
      ) {
        requestCameraFallback();
      }
    }

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("blur", handleBlur);
    window.addEventListener("focus", handleFocus);
    navigator.mediaDevices?.addEventListener?.(
      "devicechange",
      refreshDevices,
    );
    void start();

    return () => {
      cancelled = true;
      clearTimeout(focusCheckTimer);
      cancelAnimationFrame(animationFrame);
      if (
        preview &&
        videoFrameCallback &&
        typeof preview.cancelVideoFrameCallback === "function"
      ) {
        preview.cancelVideoFrameCallback(videoFrameCallback);
      }
      unsubscribe();
      activeTrack?.removeEventListener("ended", handleTrackEnded);
      void engine.stop();
      stream?.getTracks().forEach((track) => track.stop());
      if (preview && preview.srcObject === stream) preview.srcObject = null;
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("blur", handleBlur);
      window.removeEventListener("focus", handleFocus);
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        refreshDevices,
      );
      if (engineRef.current === engine) engineRef.current = null;
    };
  }, [cameraGeneration, deviceId, enabled, handleEngineEvent]);

  const openPalmThreshold = openPalmThresholdForSensitivity(sensitivity);
  const visibleStatus = paused && enabled ? "paused" : status;
  const relativeRoll = rollDegrees - neutralRollDegrees;
  const headDirection = holdDirection ?? (relativeRoll < 0 ? "left" : "right");
  const cameraStatus = visibleStatus === "error" || visibleStatus === "paused"
    ? statusCopy[visibleStatus]
    : turnFeedback ||
    (inputMode === "head"
      ? visibleStatus === "requesting" ||
        visibleStatus === "loading"
        ? statusCopy[visibleStatus]
        : visibleStatus === "cooldown"
          ? "Gesture detected — return your head to center"
          : visibleStatus === "head"
            ? `Moving ${headDirection}`
            : !facePresent
              ? "Center your face in view"
              : headState === "calibrating"
                ? `Look straight ahead — ${Math.round(holdProgress * 100)}%`
                : inverted ? "Centered — left: next · right: previous" : "Centered — right: next · left: previous"
      : visibleStatus === "ready"
        ? !handPresent
          ? "Raise your open palm into view"
          : confidence < openPalmThreshold
            ? "Hand seen — spread your fingers"
            : "Open palm ready — swipe now"
        : visibleStatus === "hand"
          ? "Open palm ready — swipe now"
          : statusCopy[visibleStatus]);
  const calibrationDirection =
    calibration === "left" || calibration === "right" ? calibration : null;
  const calibrationPrompt =
    inputMode === "head"
      ? calibration === "off"
        ? "Calibrate head tilts"
        : calibration === "complete"
          ? "Both directions are ready"
          : visibleStatus === "requesting" || visibleStatus === "loading"
            ? "Starting on-device face tracking"
            : visibleStatus === "error"
              ? "Camera needs attention"
              : visibleStatus === "cooldown"
                ? "Return your head to center"
                : !facePresent
                  ? "Center your face in the preview"
                  : headState === "calibrating"
                    ? "Look straight ahead while center is learned"
                    : visibleStatus === "head"
                      ? `Moving ${calibrationDirection}`
                      : `Centered — tilt your head ${calibrationDirection}`
      : calibration === "off"
        ? "Calibrate page turns"
        : calibration === "complete"
          ? "Both directions are ready"
          : visibleStatus === "requesting" || visibleStatus === "loading"
            ? "Starting on-device hand tracking"
            : visibleStatus === "error"
              ? "Camera needs attention"
              : visibleStatus === "cooldown"
                ? "Lower your hand briefly to reset"
                : !handPresent
                  ? "Raise your whole open palm into view"
                  : confidence < openPalmThreshold
                    ? "Spread your fingers toward the camera"
                    : `Palm ready — swipe ${calibrationDirection}`;
  const calibrationHint =
    calibrationFeedback ||
    (inputMode === "head"
      ? calibration === "off"
        ? "The camera first learns your comfortable center, then checks one deliberate tilt each way."
        : calibration === "complete"
          ? `${inverted ? "Left tilt advances; right tilt goes back." : "Right tilt advances; left tilt goes back."} ${setupModal ? "Finish, then close setup to turn pages." : "Finish to enable page turns."}`
          : visibleStatus === "cooldown"
            ? "Return to center, then tilt again. No waiting is needed."
            : visibleStatus === "head"
              ? "Keep your shoulders relaxed. Move to the turning point, then return to center."
              : facePresent
                ? `Use a comfortable ${headTiltDegrees}° tilt. Adjust the movement amount to suit you.`
                : "Keep your full face visible and look toward the screen."
      : calibration === "off"
        ? `${inverted ? "Left swipe advances; right swipe goes back." : "Right swipe advances; left swipe goes back."} Move directly, then return to your starting point. No palm lock is needed.`
        : calibration === "complete"
          ? `${inverted ? "Left swipe advances; right swipe goes back." : "Right swipe advances; left swipe goes back."} ${setupModal ? "Finish, then close setup to turn pages." : "Finish to enable page turns."}`
          : visibleStatus === "cooldown"
            ? "Return to your starting point, or lower your hand, then swipe again."
            : visibleStatus === "hand"
              ? "Keep your palm facing the camera and move across about one fifth of the preview."
              : handPresent
                ? "Keep your wrist and fingers visible as you swipe. You do not need to hold still first."
                : "Raise your hand above desk height so the full wrist and all five fingers are inside the preview.");

  function handleCalibrationButton() {
    clearTurnFeedback();
    if (calibration === "complete") {
      calibrationRef.current = "off";
      setCalibration("off");
      setCalibrationFeedback("");
      return;
    }

    calibrationRef.current = "left";
    setCalibration("left");
    setCalibrationFeedback("");
    setStatus("ready");
    setConfidence(0);
    setHandPresent(false);
    setArmProgress(0);
    setFacePresent(false);
    setHoldProgress(0);
    setHeadState("calibrating");
    engineRef.current?.reset();
  }

  function recenterHead() {
    clearTurnFeedback();
    calibrationRef.current = "off";
    setCalibration("off");
    setCalibrationFeedback("");
    setFacePresent(false);
    setRollDegrees(0);
    setNeutralRollDegrees(0);
    setHoldProgress(0);
    setHoldDirection(undefined);
    setHeadState("calibrating");
    engineRef.current?.reset(true);
  }

  function selectInputMode(mode: GestureInputMode) {
    if (mode === inputMode) return;
    clearTurnFeedback();
    savePreference("gesture-reader:input-mode", mode);
    modeRef.current = mode;
    setInputMode(mode);
    calibrationRef.current = "off";
    setCalibration("off");
    setCalibrationFeedback("");
    setFps(0);
    setConfidence(0);
    setHandPresent(false);
    setArmProgress(0);
    setFacePresent(false);
    setRollDegrees(0);
    setNeutralRollDegrees(0);
    setHoldProgress(0);
    setHoldDirection(undefined);
    setHeadState("calibrating");
    if (lastEngineStatusRef.current === "error") {
      // A fatal worker error already stopped its camera. Switching only the
      // model would report readiness without any live frames. Restart both.
      setCameraGeneration((current) => current + 1);
    } else {
      engineRef.current?.updateMode(mode);
    }
  }

  return (
    <aside
      ref={panelRef}
      className={`gesture-panel ${
        open ? "" : "gesture-panel--collapsed"
      }`}
      aria-label="Gesture controls"
      role={shortSetup && open ? "dialog" : undefined}
      aria-modal={shortSetup && open ? true : undefined}
      aria-hidden={!open}
      inert={open ? undefined : true}
      onKeyDown={(event) => {
        if (!shortSetup || !open || event.key !== "Tab") return;
        const controls = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex="0"]',
        ) ?? []).filter((control) => control.getClientRects().length > 0);
        const first = controls[0];
        const last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault(); last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first?.focus();
        }
      }}
    >
      <div className="gesture-panel__header">
        <div>
          <p className="eyebrow">Hands-free reading</p>
          <h2>Gesture setup</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          ref={closeButtonRef}
          onClick={onClose}
          aria-label="Close gesture setup"
        >
          ×
        </button>
      </div>

      <div className="gesture-panel__scroll" tabIndex={0} aria-label="Gesture setup options">
      {setupModal && <p className="calibration-mode">Setup preview · close setup to turn pages</p>}
      {status === "error" && (
        <div className="tracking-error">
          {statusMessage && <p className="inline-alert" role="alert">{statusMessage}</p>}
          <button
            type="button"
            className="primary-button camera-retry"
            onClick={() => {
              clearTurnFeedback();
              // Retry removes this button while starting. Keep keyboard focus
              // on a stable, visible setup control instead of losing it.
              closeButtonRef.current?.focus({ preventScroll: true });
              setCameraGeneration((current) => current + 1);
            }}
          >
            Try camera again
          </button>
        </div>
      )}
      <fieldset className="sensitivity-control control-method">
        <legend>Control method</legend>
        <div className="segmented-control segmented-control--two">
          {(["palm", "head"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={inputMode === value ? "is-active" : ""}
              onClick={() => selectInputMode(value)}
              aria-pressed={inputMode === value}
            >
              {value === "palm" ? "Palm swipe" : "Head tilt"}
            </button>
          ))}
        </div>
      </fieldset>

      <p className="gesture-directions">
        {inputMode === "head"
          ? `Tilt ${inverted ? "left" : "right"} to go forward, ${inverted ? "right" : "left"} to go back. Return to center between turns.`
          : `Swipe ${inverted ? "left" : "right"} to go forward, ${inverted ? "right" : "left"} to go back. Return to your starting point between turns.`}
      </p>

      <div className="whole-page-control">
        <p id="whole-page-hint">See the entire page without scrolling.</p>
        <button
          type="button"
          className={`secondary-button secondary-button--full${wholePageFitted ? " is-fitted" : ""}`}
          aria-describedby="whole-page-hint"
          disabled={!readerReady || navigationBusy || fittingPage || wholePageFitted}
          onClick={() => {
            setFittingPage(true);
            setFitError("");
            void onFitPage().then((result) => {
              if (result.status !== "confirmed") setFitError("The page could not be fitted. Try again or choose Page Fit in the PDF zoom menu.");
            }).catch(() => {
              setFitError("The page could not be fitted. Try again or choose Page Fit in the PDF zoom menu.");
            }).finally(() => setFittingPage(false));
          }}
        >
          {wholePageFitted && <span aria-hidden="true">✓ </span>}
          {fittingPage ? "Fitting page…" : wholePageFitted ? "Whole page fitted" : "Fit whole page"}
        </button>
        {fitError && !wholePageFitted && <p className="inline-alert" role="alert">{fitError}</p>}
        <p className="sr-only" role="status" aria-atomic="true">{wholePageFitted ? "Whole page fitted." : fittingPage ? "Fitting page…" : ""}</p>
      </div>

      <div
        className={`camera-frame ${showPreview ? "" : "camera-frame--hidden"} ${status === "error" ? "camera-frame--error" : ""}`}
      >
        <video ref={videoRef} muted playsInline aria-label="Mirrored camera preview" />
        {!showPreview && status !== "error" && (
          <div className="camera-frame__privacy">
            <span className="camera-frame__privacy-dot" />
            Preview hidden
          </div>
        )}
        <div className="camera-frame__status">
          <span className={`status-dot status-dot--${visibleStatus}`} />
          {cameraStatus}
        </div>
      </div>

      {statusMessage && status !== "error" && (
        <p className="inline-alert" role="alert">
          {statusMessage}
        </p>
      )}

      <p className="sr-only" role="status">{turnFeedback ? `Navigation: ${turnFeedback}` : ""}</p>

      <div className="gesture-metrics" aria-label="Gesture tracking metrics">
        <span>{fps || "—"} FPS</span>
        {inputMode === "head" ? (
          <>
            <span>
              {relativeRoll >= 0 ? "+" : ""}
              {relativeRoll.toFixed(1)}° tilt
            </span>
            <span>{headTiltDegrees}° turning point</span>
          </>
        ) : (
          <>
            <span>{Math.round(confidence * 100)}% open palm</span>
            <span>{visibleStatus === "cooldown" ? "Return to start" : "No lock needed"}</span>
          </>
        )}
      </div>

      <label className="field-label" htmlFor="camera-select">
        Camera
      </label>
      <select
        id="camera-select"
        value={deviceId || activeDeviceId}
        onChange={(event) => setDeviceId(event.target.value)}
        disabled={devices.length === 0}
      >
        {devices.length === 0 && <option value="">Default camera</option>}
        {devices.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `Camera ${index + 1}`}
          </option>
        ))}
      </select>

      {inputMode === "head" ? (
        <div className="sensitivity-control">
          <label className="field-label" htmlFor="head-tilt-amount">Head tilt amount · {headTiltDegrees}°</label>
          <input id="head-tilt-amount" type="range" min="3" max="25" step="1"
            value={headTiltDegrees} aria-describedby="head-tilt-amount-hint"
            onChange={(event) => setHeadTiltDegrees(Number(event.target.value))} />
          <p id="head-tilt-amount-hint">Smaller for gentle movements, larger to ignore ordinary leaning. Response stays fast.</p>
        </div>
      ) : <fieldset className="sensitivity-control">
        <legend>Sensitivity</legend>
        <div className="segmented-control">
          {(["low", "medium", "high"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={sensitivity === value ? "is-active" : ""}
              onClick={() => setSensitivity(value)}
              aria-pressed={sensitivity === value}
            >
              {value === "low" ? "Steady" : value === "medium" ? "Balanced" : "Quick"}
            </button>
          ))}
        </div>
      </fieldset>}

      <label className="check-row">
        <input
          type="checkbox"
          checked={showPreview}
          onChange={(event) => setShowPreview(event.target.checked)}
        />
        Show mirrored preview
      </label>
      <label className="check-row">
        <input
          type="checkbox"
          checked={inverted}
          onChange={(event) => setInverted(event.target.checked)}
        />
        Reverse page-turn direction
      </label>
      {inputMode === "head" && (
        <button
          type="button"
          className="secondary-button secondary-button--full recenter-button"
          onClick={recenterHead}
        >
          Recenter head position
        </button>
      )}

      <div className="calibration-card">
        <div>
          <p className="eyebrow">Two-step check</p>
          {calibration !== "off" && <p className="calibration-mode">Practice mode · gestures won’t turn pages</p>}
          <strong aria-live="polite">{calibrationPrompt}</strong>
          <p className="calibration-hint">{calibrationHint}</p>
        </div>
        <div className="calibration-progress" aria-hidden="true">
          <span
            className={
              calibration === "right" || calibration === "complete"
                ? "is-complete"
                : ""
            }
          />
          <span className={calibration === "complete" ? "is-complete" : ""} />
        </div>
        <button
          type="button"
          className="secondary-button secondary-button--full"
          onClick={handleCalibrationButton}
        >
          {calibration === "off"
            ? "Start calibration"
            : calibration === "complete"
              ? "Finish"
              : "Restart"}
        </button>
        {(calibration === "left" || calibration === "right") && (
          <button type="button" className="text-button calibration-cancel" onClick={endCalibration}>
            Cancel calibration
          </button>
        )}
      </div>

      <p className="privacy-note">
        Video frames and landmarks stay in memory on this device. Nothing is
        recorded or sent to a server.
      </p>
      </div>
      <div className="gesture-panel__footer">
      <button type="button" className="secondary-button secondary-button--full camera-off" onClick={onDisable}>
        Turn off gestures
      </button>
      </div>
    </aside>
  );
}
