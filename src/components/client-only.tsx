"use client";

import { ReactNode, useSyncExternalStore } from "react";

type ClientOnlyProps = {
  children: ReactNode;
  fallback?: ReactNode;
};

function subscribe() {
  return () => {};
}

function getClientSnapshot() {
  return true;
}

function getServerSnapshot() {
  return false;
}

export function ClientOnly({ children, fallback = null }: ClientOnlyProps) {
  const isClient = useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
  return <>{isClient ? children : fallback}</>;
}
