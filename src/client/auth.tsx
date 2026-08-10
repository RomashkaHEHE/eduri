import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from "react";
import { Navigate, Outlet, useLocation } from "react-router-dom";
import type { CurrentUser, Role } from "../shared/types";
import { ApiError, api } from "./api";
import { clearBoardDataForUser } from "./board/catalog";

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  setUser: (user: CurrentUser | null) => void;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);
const CACHED_USER_KEY = "eduri.last-authenticated-user";

function readCachedUser(): CurrentUser | null {
  try {
    const raw = localStorage.getItem(CACHED_USER_KEY);
    if (!raw) return null;
    const user = JSON.parse(raw) as Partial<CurrentUser>;
    if (
      typeof user.id !== "string"
      || typeof user.displayName !== "string"
      || !["admin", "tutor", "student"].includes(user.role ?? "")
      || !["pending", "active", "suspended"].includes(user.status ?? "")
    ) {
      return null;
    }
    return user as CurrentUser;
  } catch {
    return null;
  }
}

function cacheUser(user: CurrentUser | null): void {
  try {
    if (user) localStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(CACHED_USER_KEY);
  } catch {
    // Private browsing can deny localStorage while the in-memory session still works.
  }
}

export function homeForRole(role: Role) {
  if (role === "admin") return "/admin/tutors";
  if (role === "tutor") return "/tutor";
  return "/student";
}

export function AuthProvider({ children }: PropsWithChildren) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);
  const setUserAndCache = useCallback((next: CurrentUser | null) => {
    setUser(next);
    cacheUser(next);
  }, []);

  const refresh = useCallback(async () => {
    try {
      setUserAndCache(await api.auth.me());
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setUserAndCache(null);
      } else {
        console.error("Unable to restore session", error);
        setUser(readCachedUser());
      }
    } finally {
      setLoading(false);
    }
  }, [setUserAndCache]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const online = () => void refresh();
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
  }, [refresh]);

  const logout = useCallback(async () => {
    const userId = user?.id;
    try {
      await api.auth.logout();
    } finally {
      // Unmount user-scoped views first so their IndexedDB connections can
      // answer versionchange and close before the databases are deleted.
      setUserAndCache(null);
      if (userId) {
        try {
          await clearBoardDataForUser(userId);
        } catch (error) {
          console.error("Unable to clear local board data", error);
        }
      }
    }
  }, [setUserAndCache, user?.id]);

  const value = useMemo(
    () => ({ user, loading, setUser: setUserAndCache, refresh, logout }),
    [user, loading, setUserAndCache, refresh, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used inside AuthProvider");
  return context;
}

export function ProtectedRoute({ roles }: { roles?: Role[] }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="app-loading" role="status" aria-live="polite">
        <span className="spinner" />
        <span>Загрузка кабинета</span>
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  if (roles && !roles.includes(user.role)) return <Navigate to={homeForRole(user.role)} replace />;
  return <Outlet />;
}
