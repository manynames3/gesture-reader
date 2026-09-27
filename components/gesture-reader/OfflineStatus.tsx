"use client";

import { useEffect, useRef, useState } from "react";

type OfflineState = "preparing" | "ready" | "unavailable";

export function OfflineStatus() {
  const supported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const [state, setState] = useState<OfflineState>(() =>
    typeof navigator !== "undefined" && !("serviceWorker" in navigator) ? "unavailable" : "preparing",
  );
  const [attempt, setAttempt] = useState(0);
  const [updateReady, setUpdateReady] = useState(false);
  const registrationRef = useRef<ServiceWorkerRegistration | null>(null);
  const reloadRef = useRef(false);

  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || window.gestureReaderDesktop) return;
    if (!("serviceWorker" in navigator)) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let channel: MessageChannel | undefined;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    const check = (worker: ServiceWorker, repair = false) => {
      clearTimeout(timer);
      channel?.port1.close();
      channel = new MessageChannel();
      timer = setTimeout(() => { if (!disposed) setState("unavailable"); }, repair ? 60_000 : 5_000);
      channel.port1.onmessage = (event) => {
        clearTimeout(timer);
        channel?.port1.close();
        if (!disposed) setState(event.data?.ready === true
          ? navigator.serviceWorker.controller ? "ready" : "preparing"
          : "unavailable");
      };
      worker.postMessage({ type: repair ? "OFFLINE_REPAIR" : "OFFLINE_STATUS" }, [channel.port2]);
    };
    const onStateChange = () => {
      if (disposed || !registration) return;
      setUpdateReady(Boolean(registration.waiting));
      if (installing?.state === "activated") check(installing);
      if (installing?.state === "redundant" && !registration.active) setState("unavailable");
    };
    const onUpdateFound = () => {
      installing?.removeEventListener("statechange", onStateChange);
      installing = registration?.installing ?? null;
      installing?.addEventListener("statechange", onStateChange);
    };
    const onControllerChange = () => {
      if (reloadRef.current) location.reload();
      else if (navigator.serviceWorker.controller) check(navigator.serviceWorker.controller);
    };
    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    void navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).then((result) => {
      if (disposed) return;
      registration = result;
      registrationRef.current = result;
      setUpdateReady(Boolean(result.waiting));
      result.addEventListener("updatefound", onUpdateFound);
      onUpdateFound();
      if (result.active) check(result.active, attempt > 0);
    }).catch(() => { if (!disposed) setState("unavailable"); });
    return () => {
      disposed = true;
      clearTimeout(timer);
      channel?.port1.close();
      installing?.removeEventListener("statechange", onStateChange);
      registration?.removeEventListener("updatefound", onUpdateFound);
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    };
  }, [attempt]);

  if (process.env.NODE_ENV !== "production") return null;
  return (
    <div className="offline-status">
      <p role="status">
        {state === "ready" ? "Ready offline — PDFs and gesture controls are available without internet."
          : state === "preparing" ? "Preparing offline reading… Keep this tab open while the app files download."
          : supported ? "Offline setup is incomplete. Reading still works while connected."
          : "Offline mode is unavailable in this browser. You can still read while connected."}
      </p>
      {state === "unavailable" && supported && <button type="button" className="text-button" onClick={() => {
        setState("preparing");
        setAttempt((value) => value + 1);
      }}>Retry offline setup</button>}
      {updateReady && <button type="button" className="secondary-button" onClick={() => {
        reloadRef.current = true;
        registrationRef.current?.waiting?.postMessage({ type: "ACTIVATE_UPDATE" });
      }}>Update app and reload</button>}
    </div>
  );
}
