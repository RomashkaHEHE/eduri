import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, LoaderCircle, Users, X } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import {
  CodeWorkspace,
  type CodeWorkspaceSessionHandle,
} from "../components/CodeWorkspace";
import { promoteSoloCodeToGuestRoom } from "../code/promoteSoloCode";
import { ThemeToggle } from "../theme";

export function SoloCodePage() {
  const navigate = useNavigate();
  const [session, setSession] = useState<CodeWorkspaceSessionHandle | null>(
    null,
  );
  const [promoting, setPromoting] = useState(false);
  const [promotionError, setPromotionError] = useState<string | null>(null);
  const promotionAbortRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      promotionAbortRef.current?.abort();
    };
  }, []);

  const handleSessionReady = useCallback((next: CodeWorkspaceSessionHandle | null) => {
    if (mountedRef.current) setSession(next);
  }, []);

  const startSession = useCallback(async () => {
    if (!session || promoting) return;
    const abortController = new AbortController();
    promotionAbortRef.current = abortController;
    setPromoting(true);
    setPromotionError(null);
    try {
      const room = await promoteSoloCodeToGuestRoom({
        session,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) return;
      const codeUrl = room.resources.find((resource) => (
        resource.kind === "code"
      ))?.url ?? `/room/${encodeURIComponent(room.shareId)}/code`;
      navigate(codeUrl);
    } catch (error) {
      if (
        abortController.signal.aborted
        || (error instanceof Error && error.name === "AbortError")
      ) {
        return;
      }
      console.error("Solo Code promotion failed", error);
      if (mountedRef.current) {
        setPromotionError(
          "Не удалось начать сеанс. Проверьте соединение и попробуйте ещё раз.",
        );
      }
    } finally {
      if (promotionAbortRef.current === abortController) {
        promotionAbortRef.current = null;
        if (mountedRef.current) setPromoting(false);
      }
    }
  }, [navigate, promoting, session]);

  return (
    <main className="public-workspace public-workspace--code">
      <header className="public-workspace__bar">
        <Link className="public-workspace__back" to="/" aria-label="На главную">
          <ArrowLeft size={18} />
        </Link>
        <strong>Python</strong>
        <div className="public-workspace__session-actions">
          <ThemeToggle />
          <span className="public-workspace__mode">Личный режим</span>
          <button
            type="button"
            className="button button--primary button--small public-workspace__start-session"
            disabled={!session || promoting}
            onClick={() => void startSession()}
          >
            {promoting
              ? <LoaderCircle className="spin" size={15} />
              : <Users size={15} />}
            <span>{promoting ? "Создаём сеанс" : "Начать сеанс"}</span>
          </button>
        </div>
      </header>
      <div className="public-code-stage">
        {promotionError && (
          <div className="public-workspace__promotion-error" role="alert">
            <span>{promotionError}</span>
            <button
              type="button"
              onClick={() => setPromotionError(null)}
              aria-label="Закрыть сообщение"
            >
              <X size={15} />
            </button>
          </div>
        )}
        <CodeWorkspace
          persistenceName="eduri-code-workspace-v1:guest-solo"
          onSessionReady={handleSessionReady}
          readOnly={promoting}
        />
      </div>
    </main>
  );
}
