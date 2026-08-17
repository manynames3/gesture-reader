"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { BrowserGestureEngine } from "@/lib/gesture/browserGestureEngine";
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
  onDisable(): void;
  onGesture(
    direction: "left" | "right",
    source: "palmSwipe" | "headTilt",
  ): Promise<NavigationResult>;
}

type CalibrationStep = "off" | "left" | "right" | "complete";

const statusCopy: Record<GestureStatus, string> = {
  off: "Camera off",
  requesting: "Waiting for permission",
  loading: "Loading hand tracking",
  ready: "Ready for an open palm",
  hand: "Palm detected — swipe",
  head: "Head tilt detected — hold",
  cooldown: "Gesture detected — reset your hand",
  paused: "Paused",
  error: "Camera needs attention",
};

function loadPreference<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored === null ? fallback : (JSON.parse(stored) as T);
  } catch {
    return fallback;
  }
}

export function GesturePanel({
  enabled,
  open,
  paused,
  navigationBusy,
  onDisable,
  onGesture,
}: GesturePanelProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const engineRef = useRef<BrowserGestureEngine | null>(null);
  const calibrationRef = useRef<CalibrationStep>("off");
  const pausedRef = useRef(paused);
  const externalPausedRef = useRef(paused);
  const navigationBusyRef = useRef(navigationBusy);
  const navigationRequestInFlightRef = useRef(false);
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
  const [deviceId, setDeviceId] = useState("");
  const [activeDeviceId, setActiveDeviceId] = useState("");
  const [cameraGeneration, setCameraGeneration] = useState(0);
  const [sensitivity, setSensitivity] = useState<GestureSensitivity>(() =>
    typeof window === "undefined"
      ? "medium"
      : loadPreference("gesture-reader:sensitivity", "medium"),
  );
  const [inputMode, setInputMode] = useState<GestureInputMode>(() =>
    typeof window === "undefined"
      ? "palm"
      : loadPreference("gesture-reader:input-mode", "palm"),
  );
  const modeRef = useRef<GestureInputMode>(inputMode);
  const [inverted, setInverted] = useState(() =>
    typeof window === "undefined"
      ? false
      : loadPreference("gesture-reader:inverted", false),
  );
  const [showPreview, setShowPreview] = useState(true);
  const [fps, setFps] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [handPresent, setHandPresent] = useState(false);
  const [armProgress, setArmProgress] = useState(0);
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

  // Camera events do not wait for passive effects. Update every event guard
  // before paint so the first gesture after a modal closes is not discarded.
  useLayoutEffect(() => {
    externalPausedRef.current = paused;
    pausedRef.current = paused || !windowFocusedRef.current;
    navigationBusyRef.current = navigationBusy;
    onDisableRef.current = onDisable;
    onGestureRef.current = onGesture;
    calibrationRef.current = calibration;
  }, [calibration, navigationBusy, onDisable, onGesture, paused]);

  const clearTurnFeedback = useCallback(() => {
    turnFeedbackGenerationRef.current += 1;
    clearTimeout(turnFeedbackTimerRef.current);
    setTurnFeedback("");
  }, []);

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
    localStorage.setItem(
      "gesture-reader:sensitivity",
      JSON.stringify(sensitivity),
    );
    sensitivityRef.current = sensitivity;
    engineRef.current?.updateSensitivity(sensitivity);
  }, [sensitivity]);

  useEffect(() => {
    localStorage.setItem("gesture-reader:inverted", JSON.stringify(inverted));
    invertedRef.current = inverted;
  }, [inverted]);

  const handleEngineEvent = useCallback(
    (event: GestureEvent) => {
      if (event.type === "status") {
        lastEngineStatusRef.current = event.status;
        if (!pausedRef.current) setStatus(event.status);
        setStatusMessage(event.message ?? "");
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

      // A frame can finish after a modal opens, the page starts animating, or
      // the window loses focus. Never let that stale result turn a page.
      if (
        pausedRef.current ||
        navigationBusyRef.current ||
        navigationRequestInFlightRef.current
      ) {
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

      const direction = invertedRef.current
        ? event.direction === "left"
          ? "right"
          : "left"
        : event.direction;
      const feedbackGeneration = turnFeedbackGenerationRef.current + 1;
      turnFeedbackGenerationRef.current = feedbackGeneration;
      navigationRequestInFlightRef.current = true;
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
        })
        .finally(() => {
          navigationRequestInFlightRef.current = false;
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
    let stream: MediaStream | undefined;
    let activeTrack: MediaStreamTrack | undefined;
    let currentStreamDeviceId = "";
    let lastFrameAt = 0;
    let lastFrameId: number | undefined;
    const engine = new BrowserGestureEngine();
    const preview = videoRef.current;
    engineRef.current = engine;
    const unsubscribe = engine.subscribe(handleEngineEvent);

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
      if (cancelled) return;
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
          const scale = Math.min(
            1,
            640 / Math.max(1, video.videoWidth),
            480 / Math.max(1, video.videoHeight),
          );
          const bitmap = await createImageBitmap(video, {
            resizeWidth: Math.max(1, Math.round(video.videoWidth * scale)),
            resizeHeight: Math.max(1, Math.round(video.videoHeight * scale)),
            resizeQuality: "medium",
          });
          if (cancelled) {
            bitmap.close();
            return;
          }
          if (engine.submitFrame(bitmap, timestamp)) {
            lastFrameAt = timestamp;
            lastFrameId = frameId;
          }
        } catch {
          try {
            const bitmap = await createImageBitmap(video);
            if (cancelled) {
              bitmap.close();
              return;
            }
            if (engine.submitFrame(bitmap, timestamp)) {
              lastFrameAt = timestamp;
              lastFrameId = frameId;
            }
          } catch {
            if (!cancelled) {
              lastEngineStatusRef.current = "error";
              setStatus("error");
              setStatusMessage(
                "This browser cannot pass camera frames to on-device hand tracking.",
              );
            }
          }
        }
      }
    }

    function scheduleFrameCapture() {
      if (cancelled || !preview) return;
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
        });
        if (cancelled) {
          await discardStaleStart();
          return;
        }
        scheduleFrameCapture();
      } catch (error) {
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
      windowFocusedRef.current = false;
      pausedRef.current = true;
      setStatus("paused");
    }
    function handleFocus() {
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
  const cameraStatus = turnFeedback ||
    (inputMode === "head"
      ? visibleStatus === "requesting" ||
        visibleStatus === "loading" ||
        visibleStatus === "paused" ||
        visibleStatus === "error"
        ? statusCopy[visibleStatus]
        : visibleStatus === "cooldown"
          ? "Gesture detected — return your head to center"
          : visibleStatus === "head"
            ? `Hold ${headDirection} — ${Math.round(holdProgress * 100)}%`
            : !facePresent
              ? "Center your face in view"
              : headState === "calibrating"
                ? `Look straight ahead — ${Math.round(holdProgress * 100)}%`
                : "Centered — right: next · left: previous"
      : visibleStatus === "ready"
        ? !handPresent
          ? "Raise your open palm into view"
          : confidence < openPalmThreshold
            ? "Hand seen — spread your fingers"
            : `Hold steady — ${armProgress}/3`
        : visibleStatus === "hand"
          ? "Palm locked — swipe now"
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
                      ? `Keep holding ${calibrationDirection} — ${Math.round(holdProgress * 100)}%`
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
                    ? "Spread your fingers and hold still"
                    : visibleStatus !== "hand"
                      ? `Hold still — palm lock ${armProgress}/3`
                      : `Palm ready — swipe ${calibrationDirection}`;
  const calibrationHint =
    calibrationFeedback ||
    (inputMode === "head"
      ? calibration === "off"
        ? "The camera first learns your comfortable center, then checks one deliberate tilt each way."
        : calibration === "complete"
          ? "Right tilt advances; left tilt goes back. Finish to enable page turns."
          : visibleStatus === "cooldown"
            ? "Come fully back to center and hold briefly before tilting the other way."
            : visibleStatus === "head"
              ? "Keep your shoulders relaxed and hold the tilt until the progress reaches 100%."
              : facePresent
                ? "Use a comfortable 12–15° tilt. You do not need to move your shoulders."
                : "Keep your full face visible and look toward the screen."
      : calibration === "off"
        ? "Hold your palm still for a beat, then check one swipe in each direction."
        : calibration === "complete"
          ? "Calibration passed. Finish to enable page turns."
          : visibleStatus === "cooldown"
            ? "Move your hand out of the preview, wait for Ready, then raise it again."
            : visibleStatus === "hand"
              ? "Keep your palm facing the camera and move across about one fifth of the preview."
              : handPresent
                ? "Keep your wrist and all five fingers visible until the palm lock reaches 3/3."
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
    engineRef.current?.reset();
  }

  function selectInputMode(mode: GestureInputMode) {
    if (mode === inputMode) return;
    clearTurnFeedback();
    localStorage.setItem(
      "gesture-reader:input-mode",
      JSON.stringify(mode),
    );
    modeRef.current = mode;
    setInputMode(mode);
    calibrationRef.current = "off";
    setCalibration("off");
    setCalibrationFeedback("");
    setConfidence(0);
    setHandPresent(false);
    setArmProgress(0);
    setFacePresent(false);
    setRollDegrees(0);
    setNeutralRollDegrees(0);
    setHoldProgress(0);
    setHoldDirection(undefined);
    setHeadState("calibrating");
    engineRef.current?.updateMode(mode);
  }

  return (
    <aside
      className={`gesture-panel ${
        open ? "" : "gesture-panel--collapsed"
      }`}
      aria-label="Gesture controls"
      aria-hidden={!open}
      inert={open ? undefined : true}
    >
      <div className="gesture-panel__header">
        <div>
          <p className="eyebrow">On-device vision</p>
          <h2>Gesture setup</h2>
        </div>
        <button
          type="button"
          className="icon-button"
          onClick={onDisable}
          aria-label="Turn off gestures"
        >
          ×
        </button>
      </div>

      <div
        className={`camera-frame ${showPreview ? "" : "camera-frame--hidden"}`}
      >
        <video ref={videoRef} muted playsInline aria-label="Mirrored camera preview" />
        {!showPreview && (
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

      {statusMessage && (
        <p className="inline-alert" role="alert">
          {statusMessage}
        </p>
      )}

      <div className="gesture-metrics" aria-label="Gesture tracking metrics">
        <span>{fps || "—"} FPS</span>
        {inputMode === "head" ? (
          <>
            <span>
              {relativeRoll >= 0 ? "+" : ""}
              {relativeRoll.toFixed(1)}° tilt
            </span>
            <span>{Math.round(holdProgress * 100)}% hold</span>
          </>
        ) : (
          <>
            <span>{Math.round(confidence * 100)}% open palm</span>
            <span>{armProgress}/3 lock</span>
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

      <fieldset className="sensitivity-control">
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

      <fieldset className="sensitivity-control">
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
      </fieldset>

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
      </div>

      <p className="privacy-note">
        Video frames and landmarks stay in memory on this device. Nothing is
        recorded or sent to a server.
      </p>
    </aside>
  );
}
