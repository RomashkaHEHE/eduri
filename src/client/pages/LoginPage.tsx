import { useEffect, useState, type FormEvent } from "react";
import { GraduationCap, KeyRound, LogIn, UserRound } from "lucide-react";
import { Navigate, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../api";
import { homeForRole, useAuth } from "../auth";
import { Button, FormField, Notice } from "../components/UI";
import { ThemeToggle } from "../theme";

type LoginMode = "student" | "staff";

export function LoginPage() {
  const { user, loading: sessionLoading, setUser } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState<LoginMode>("student");
  const [loginName, setLoginName] = useState("");
  const [secret, setSecret] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSecret("");
    setError(null);
  }, [mode]);

  if (!sessionLoading && user) return <Navigate to={homeForRole(user.role)} replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = mode === "student"
        ? await api.auth.loginStudent(loginName.trim(), secret)
        : await api.auth.loginStaff(loginName.trim(), secret);
      setUser(result.user);
      const requestedPath = (location.state as { from?: string } | null)?.from;
      navigate(requestedPath || homeForRole(result.user.role), { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Проверьте введённые данные");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <ThemeToggle className="theme-toggle--floating" />
      <section className="auth-panel" aria-labelledby="login-title">
        <div className="auth-brand"><span className="brand-mark"><GraduationCap size={23} /></span><span>Eduri</span></div>
        <div className="auth-heading">
          <h1 id="login-title">Вход в кабинет</h1>
          <p>Используйте данные, которые вы получили от репетитора или администратора.</p>
        </div>

        {searchParams.get("activated") === "1" && <Notice type="success">Аккаунт активирован. Можно входить.</Notice>}

        <div className="segmented" role="group" aria-label="Тип аккаунта">
          <button className={mode === "student" ? "is-active" : ""} type="button" onClick={() => setMode("student")}>
            <UserRound size={17} />Ученик
          </button>
          <button className={mode === "staff" ? "is-active" : ""} type="button" onClick={() => setMode("staff")}>
            <KeyRound size={17} />Сотрудник
          </button>
        </div>

        <form className="form-stack" onSubmit={onSubmit}>
          <FormField label={mode === "student" ? "Имя для входа" : "Логин"}>
            <input
              value={loginName}
              onChange={(event) => setLoginName(event.target.value)}
              autoComplete="username"
              required
              autoFocus
            />
          </FormField>
          <FormField label={mode === "student" ? "Кодовое слово" : "Пароль"}>
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              autoComplete="current-password"
              required
            />
          </FormField>
          {error && <Notice type="error">{error}</Notice>}
          <Button type="submit" disabled={submitting || !loginName.trim() || !secret} icon={<LogIn size={18} />}>
            {submitting ? "Входим…" : "Войти"}
          </Button>
        </form>
      </section>
    </main>
  );
}
