import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type PropsWithChildren,
} from "react";
import { UserRound } from "lucide-react";
import {
  COLLABORATION_PROFILE_COLORS,
  COLLABORATION_PROFILE_DISPLAY_NAME_MAX_CHARACTERS,
  CollaborationProfileValidationError,
  normalizeCollaborationDisplayName,
  normalizeCollaborationProfile,
  type CollaborationProfile,
} from "../shared/collaborationProfile";
import { BoardColorPicker } from "./board/BoardColorPicker";
import { Button, FormField, IconButton, Modal } from "./components/UI";

export const ONLINE_PROFILE_STORAGE_KEY = "eduri-online-profile-v1";
export const ONLINE_PROFILE_VERSION = 1;
export const DEFAULT_ONLINE_PROFILE_COLOR = COLLABORATION_PROFILE_COLORS[0];
export const ONLINE_PROFILE_DISPLAY_NAME_MAX_LENGTH =
  COLLABORATION_PROFILE_DISPLAY_NAME_MAX_CHARACTERS;

export type OnlineProfile = CollaborationProfile;

export interface OnlineProfileInput {
  readonly displayName: string;
  readonly color: string;
}

interface StoredOnlineProfile {
  readonly version: typeof ONLINE_PROFILE_VERSION;
  readonly displayName: string;
  readonly color: `#${string}`;
}

interface ProfileDialogState {
  readonly open: boolean;
  readonly required: boolean;
  readonly defaultDisplayName: string;
  readonly revision: number;
}

interface OnlineProfileContextValue {
  readonly profile: OnlineProfile | null;
  readonly configured: boolean;
  readonly dialog: ProfileDialogState;
  readonly save: (input: OnlineProfileInput) => OnlineProfile;
  readonly openEditor: () => void;
  readonly requireProfile: (defaultDisplayName?: string) => void;
  readonly releaseProfileRequirement: () => void;
  readonly closeEditor: () => void;
}

export interface UseOnlineProfileOptions {
  readonly defaultDisplayName?: string;
  readonly required?: boolean;
}

export interface UseOnlineProfileResult {
  readonly profile: OnlineProfile | null;
  readonly configured: boolean;
  readonly save: (input: OnlineProfileInput) => OnlineProfile;
  readonly openEditor: () => void;
}

const EMPTY_DIALOG: ProfileDialogState = Object.freeze({
  open: false,
  required: false,
  defaultDisplayName: "",
  revision: 0,
});
const OnlineProfileContext = createContext<OnlineProfileContextValue | null>(null);

let memoryProfile: OnlineProfile | null = null;
let memoryFallbackActive = false;

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function copyProfile(profile: OnlineProfile | null): OnlineProfile | null {
  return profile ? { ...profile } : null;
}

function sameProfile(
  left: OnlineProfile | null,
  right: OnlineProfile | null,
): boolean {
  return left === right || Boolean(
    left
    && right
    && left.displayName === right.displayName
    && left.color === right.color,
  );
}

export function normalizeOnlineProfile(
  input: OnlineProfileInput,
): OnlineProfile | null {
  try {
    const profile = normalizeCollaborationProfile(input);
    return { ...profile };
  } catch (error) {
    if (error instanceof CollaborationProfileValidationError) return null;
    throw error;
  }
}

export function parseOnlineProfileStorage(
  serialized: string | null,
): OnlineProfile | null {
  if (serialized === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }
  const record = plainRecord(value);
  if (!record) return null;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 3
    || keys[0] !== "color"
    || keys[1] !== "displayName"
    || keys[2] !== "version"
    || record.version !== ONLINE_PROFILE_VERSION
    || typeof record.displayName !== "string"
    || typeof record.color !== "string"
  ) {
    return null;
  }
  const profile = normalizeOnlineProfile({
    displayName: record.displayName,
    color: record.color,
  });
  if (
    !profile
    || profile.displayName !== record.displayName
    || profile.color !== record.color
  ) {
    return null;
  }
  return profile;
}

function browserStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function removeInvalidStorage(storage: Storage): void {
  try {
    storage.removeItem(ONLINE_PROFILE_STORAGE_KEY);
  } catch {
    // A rejected cleanup must not make the in-memory profile unavailable.
  }
}

export function loadOnlineProfile(
  storage: Storage | null = browserStorage(),
): OnlineProfile | null {
  if (!storage) return copyProfile(memoryProfile);
  let serialized: string | null;
  try {
    serialized = storage.getItem(ONLINE_PROFILE_STORAGE_KEY);
  } catch {
    return copyProfile(memoryProfile);
  }
  if (serialized === null) {
    if (memoryFallbackActive) return copyProfile(memoryProfile);
    memoryProfile = null;
    return null;
  }
  const profile = parseOnlineProfileStorage(serialized);
  if (!profile) {
    removeInvalidStorage(storage);
    if (memoryFallbackActive) return copyProfile(memoryProfile);
    memoryProfile = null;
    return null;
  }
  memoryProfile = profile;
  memoryFallbackActive = false;
  return copyProfile(profile);
}

export function saveOnlineProfile(
  input: OnlineProfileInput,
  storage: Storage | null = browserStorage(),
): OnlineProfile {
  const profile = normalizeOnlineProfile(input);
  if (!profile) throw new TypeError("Online profile is invalid");
  memoryProfile = profile;
  const stored: StoredOnlineProfile = {
    version: ONLINE_PROFILE_VERSION,
    displayName: profile.displayName,
    color: profile.color,
  };
  try {
    if (!storage) throw new DOMException("Storage unavailable", "SecurityError");
    storage.setItem(ONLINE_PROFILE_STORAGE_KEY, JSON.stringify(stored));
    memoryFallbackActive = false;
  } catch {
    memoryFallbackActive = true;
  }
  return { ...profile };
}

export function resetOnlineProfileMemoryForTests(): void {
  memoryProfile = null;
  memoryFallbackActive = false;
}

function applyExternalStorageValue(serialized: string | null): OnlineProfile | null {
  const profile = parseOnlineProfileStorage(serialized);
  if (serialized !== null && !profile) {
    const storage = browserStorage();
    if (storage) removeInvalidStorage(storage);
  }
  memoryProfile = profile;
  memoryFallbackActive = false;
  return copyProfile(profile);
}

function safeDefaultDisplayName(value: string | undefined): string {
  if (value === undefined) return "";
  try {
    return normalizeCollaborationDisplayName(value);
  } catch (error) {
    if (error instanceof CollaborationProfileValidationError) return "";
    throw error;
  }
}

function displayNameError(value: string): string | null {
  if (!value.trim()) return "Укажите Display Name";
  try {
    normalizeCollaborationDisplayName(value);
    return null;
  } catch (error) {
    if (!(error instanceof CollaborationProfileValidationError)) throw error;
    return `До ${ONLINE_PROFILE_DISPLAY_NAME_MAX_LENGTH} символов, без переносов и управляющих знаков`;
  }
}

function readableProfileText(color: string): "#111827" | "#ffffff" {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const luminance = (red * 299 + green * 587 + blue * 114) / 1_000;
  return luminance > 160 ? "#111827" : "#ffffff";
}

function profileInitial(
  profile: OnlineProfile | null,
  defaultDisplayName: string,
): OnlineProfile {
  return profile ?? {
    displayName: safeDefaultDisplayName(defaultDisplayName),
    color: DEFAULT_ONLINE_PROFILE_COLOR,
  };
}

function ProfileDialog({
  state,
  profile,
  onSave,
  onClose,
}: {
  readonly state: ProfileDialogState;
  readonly profile: OnlineProfile | null;
  readonly onSave: (input: OnlineProfileInput) => void;
  readonly onClose: () => void;
}) {
  const initial = profileInitial(profile, state.defaultDisplayName);
  const [displayName, setDisplayName] = useState(profile?.displayName ?? "");
  const [color, setColor] = useState<string>(initial.color);
  const [submitted, setSubmitted] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);
  const effectiveDisplayName = displayName || (!profile ? initial.displayName : "");
  const nameError = displayNameError(effectiveDisplayName);
  const previewName = safeDefaultDisplayName(effectiveDisplayName) || "Display Name";
  const previewLetter = [...previewName][0]?.toLocaleUpperCase() ?? "";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(true);
    const next = normalizeOnlineProfile({ displayName: effectiveDisplayName, color });
    if (next) onSave(next);
  };

  return (
    <Modal
      open={state.open}
      title="Профиль"
      width="small"
      dismissible
      backdropClassName="modal-backdrop--online-profile"
      onClose={onClose}
    >
      <form className="online-profile-form" onSubmit={submit}>
        <div className="online-profile-preview">
          <span
            className="online-profile-preview__avatar"
            style={{
              "--online-profile-color": color,
              "--online-profile-on-color": readableProfileText(color),
            } as CSSProperties}
            aria-hidden="true"
          >
            {previewLetter}
          </span>
          <strong>{previewName}</strong>
        </div>
        <FormField
          label="Display Name"
          error={submitted || nameTouched ? nameError ?? undefined : undefined}
        >
          <input
            value={displayName}
            placeholder={profile ? undefined : initial.displayName || "Гость"}
            autoComplete="nickname"
            autoFocus
            aria-invalid={(submitted || nameTouched) && Boolean(nameError)}
            onChange={(event) => setDisplayName(event.currentTarget.value)}
            onBlur={() => setNameTouched(true)}
          />
        </FormField>
        <div className="online-profile-color-field">
          <span className="online-profile-color-field__label">Цвет</span>
          <BoardColorPicker
            value={color}
            label="Цвет профиля"
            onPreview={setColor}
            onCommit={setColor}
          />
        </div>
        <div className="modal-actions">
          <Button type="button" variant="secondary" onClick={onClose}>
            Отмена
          </Button>
          <Button type="submit" disabled={Boolean(nameError)}>
            Сохранить
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function OnlineProfileProvider({ children }: PropsWithChildren) {
  const [profile, setProfile] = useState<OnlineProfile | null>(loadOnlineProfile);
  const [dialog, setDialog] = useState<ProfileDialogState>(EMPTY_DIALOG);
  const profileRef = useRef(profile);
  const suggestedDefaultDisplayNameRef = useRef("");
  profileRef.current = profile;

  const reconcile = useCallback((next: OnlineProfile | null) => {
    profileRef.current = next;
    setProfile((current) => sameProfile(current, next) ? current : next);
    setDialog((current) => {
      if (!current.open) return current;
      if (next) return { ...EMPTY_DIALOG, revision: current.revision };
      return current.required ? current : { ...current, required: true };
    });
  }, []);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== ONLINE_PROFILE_STORAGE_KEY) return;
      if (event.key === ONLINE_PROFILE_STORAGE_KEY) {
        reconcile(applyExternalStorageValue(event.newValue));
        return;
      }
      reconcile(applyExternalStorageValue(null));
    };
    const handlePageShow = () => reconcile(loadOnlineProfile());
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") reconcile(loadOnlineProfile());
    };
    window.addEventListener("storage", handleStorage);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    reconcile(loadOnlineProfile());
    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [reconcile]);

  const save = useCallback((input: OnlineProfileInput) => {
    const saved = saveOnlineProfile(input);
    profileRef.current = saved;
    setProfile(saved);
    setDialog((current) => ({
      ...EMPTY_DIALOG,
      revision: current.revision,
    }));
    return saved;
  }, []);

  const openEditor = useCallback(() => {
    const required = profileRef.current === null;
    setDialog((current) => ({
      open: true,
      required,
      defaultDisplayName: required ? suggestedDefaultDisplayNameRef.current : "",
      revision: current.revision + 1,
    }));
  }, []);

  const requireProfile = useCallback((defaultDisplayName = "") => {
    if (profileRef.current) return;
    const normalizedDefaultDisplayName = safeDefaultDisplayName(defaultDisplayName);
    suggestedDefaultDisplayNameRef.current = normalizedDefaultDisplayName;
    setDialog((current) => {
      if (current.open && current.required) return current;
      return {
        open: true,
        required: true,
        defaultDisplayName: normalizedDefaultDisplayName,
        revision: current.revision + 1,
      };
    });
  }, []);

  const releaseProfileRequirement = useCallback(() => {
    setDialog((current) => current.required
      ? { ...EMPTY_DIALOG, revision: current.revision }
      : current);
  }, []);

  const closeEditor = useCallback(() => {
    setDialog((current) => ({ ...EMPTY_DIALOG, revision: current.revision }));
  }, []);

  const value = useMemo<OnlineProfileContextValue>(() => ({
    profile,
    configured: profile !== null,
    dialog,
    save,
    openEditor,
    requireProfile,
    releaseProfileRequirement,
    closeEditor,
  }), [
    closeEditor,
    dialog,
    openEditor,
    profile,
    releaseProfileRequirement,
    requireProfile,
    save,
  ]);

  return (
    <OnlineProfileContext.Provider value={value}>
      {children}
      <ProfileDialog
        key={dialog.revision}
        state={dialog}
        profile={profile}
        onSave={save}
        onClose={closeEditor}
      />
    </OnlineProfileContext.Provider>
  );
}

function useOnlineProfileContext(): OnlineProfileContextValue {
  const context = useContext(OnlineProfileContext);
  if (!context) {
    throw new Error("useOnlineProfile must be used inside OnlineProfileProvider");
  }
  return context;
}

export function useOnlineProfile(
  options: UseOnlineProfileOptions = {},
): UseOnlineProfileResult {
  const context = useOnlineProfileContext();
  const shouldRequire = options.required
    ?? Object.prototype.hasOwnProperty.call(options, "defaultDisplayName");
  const activeProfile = shouldRequire
    ? profileInitial(context.profile, options.defaultDisplayName ?? "")
    : context.profile;
  useEffect(() => {
    if (shouldRequire && !context.configured) {
      context.requireProfile(options.defaultDisplayName);
    } else if (!shouldRequire) {
      context.releaseProfileRequirement();
    }
  }, [
    context.configured,
    context.releaseProfileRequirement,
    context.requireProfile,
    options.defaultDisplayName,
    shouldRequire,
  ]);
  return {
    profile: activeProfile,
    configured: context.configured,
    save: context.save,
    openEditor: context.openEditor,
  };
}

export function OnlineProfileButton({
  className = "",
}: {
  readonly className?: string;
}) {
  const context = useOnlineProfileContext();
  const color = context.profile?.color ?? DEFAULT_ONLINE_PROFILE_COLOR;
  return (
    <IconButton
      label="Профиль"
      className={`online-profile-button ${className}`.trim()}
      aria-haspopup="dialog"
      aria-expanded={context.dialog.open}
      style={{ "--online-profile-color": color } as CSSProperties}
      onClick={context.openEditor}
    >
      <UserRound size={18} />
      <span className="online-profile-button__color" aria-hidden="true" />
    </IconButton>
  );
}
