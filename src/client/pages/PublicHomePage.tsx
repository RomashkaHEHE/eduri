import { useCallback, useState } from "react";
import { Braces, LogIn, Phone, Presentation } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { ApiError, api } from "../api";
import { homeForRole, useAuth } from "../auth";
import { ThemeToggle } from "../theme";

export function PublicHomePage() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [startingCall, setStartingCall] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const startCall = useCallback(async () => {
    if (startingCall) return;
    setStartingCall(true);
    setError(null);
    try {
      const room = await api.guestRooms.create("call");
      navigate(`/room/${room.shareId}/call`, {
        state: { autoJoinCall: true },
      });
    } catch (reason) {
      setError(reason instanceof ApiError
        ? reason.message
        : "Не удалось начать звонок");
    } finally {
      setStartingCall(false);
    }
  }, [navigate, startingCall]);

  const accountHref = user ? homeForRole(user.role) : "/login";

  return (
    <main className="public-home">
      <header className="public-home__header">
        <Link className="public-brand" to="/" aria-label="Eduri">
          <span className="brand-mark" aria-hidden="true"><img src="/favicon.svg" alt="" /></span>
          <strong>Eduri</strong>
        </Link>
        <div className="public-home__account-actions">
          <ThemeToggle />
          <Link className="public-account-link" to={accountHref}>
            <LogIn size={17} />
            {loading ? "Войти" : user ? "Личный кабинет" : "Войти"}
          </Link>
        </div>
      </header>

      <section className="public-home__actions" aria-label="Начать работу">
        <Link className="public-action" to="/board">
          <Presentation size={24} />
          <span>Перейти к доске</span>
        </Link>
        <Link className="public-action" to="/code">
          <Braces size={24} />
          <span>Перейти к коду</span>
        </Link>
        <button
          className="public-action"
          type="button"
          disabled={startingCall}
          onClick={() => void startCall()}
        >
          <Phone size={24} />
          <span>{startingCall ? "Создаём звонок" : "Начать звонок"}</span>
        </button>
      </section>
      {error && <p className="public-home__error" role="alert">{error}</p>}
    </main>
  );
}
