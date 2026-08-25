"use client";

import { type ControlStatus, controlApiUrl, type SignalMonitorSnapshot } from "./api";

export function subscribeToStatus(
  onStatus: (status: ControlStatus) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${controlApiUrl}/api/stream`);
  source.addEventListener("status", (event) => {
    try {
      onStatus(JSON.parse((event as MessageEvent<string>).data) as ControlStatus);
      onConnection(true);
    } catch {
      onConnection(false);
    }
  });
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  return () => source.close();
}

export function subscribeToSignalMonitor(
  onSnapshot: (snapshot: SignalMonitorSnapshot) => void,
  onConnection: (connected: boolean) => void,
): () => void {
  const source = new EventSource(`${controlApiUrl}/api/signal-monitor/stream`);
  source.addEventListener("snapshot", (event) => {
    try {
      onSnapshot(JSON.parse((event as MessageEvent<string>).data) as SignalMonitorSnapshot);
      onConnection(true);
    } catch {
      onConnection(false);
    }
  });
  source.onopen = () => onConnection(true);
  source.onerror = () => onConnection(false);
  return () => source.close();
}
