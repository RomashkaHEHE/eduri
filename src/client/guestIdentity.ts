const GUEST_DEVICE_STORAGE_KEY = "eduri.guest-device-id.v1";
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/u;

let memoryDeviceId: string | null = null;

function newDeviceId(): string {
  return crypto.randomUUID().replace(/-/gu, "");
}

export function guestDeviceId(): string {
  if (memoryDeviceId) return memoryDeviceId;
  try {
    const stored = window.localStorage.getItem(GUEST_DEVICE_STORAGE_KEY);
    if (stored && DEVICE_ID_PATTERN.test(stored)) {
      memoryDeviceId = stored;
      return stored;
    }
  } catch {
    // Private browsing may expose localStorage while rejecting access.
  }

  memoryDeviceId = newDeviceId();
  try {
    window.localStorage.setItem(GUEST_DEVICE_STORAGE_KEY, memoryDeviceId);
  } catch {
    // The in-memory identity still keeps reconnects stable for this page.
  }
  return memoryDeviceId;
}

export function resetGuestDeviceIdForTests(): void {
  memoryDeviceId = null;
}
