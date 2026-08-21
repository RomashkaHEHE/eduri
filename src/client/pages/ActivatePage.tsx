import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, KeyRound } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import type { InvitePreview } from "../api";
import { api } from "../api";
import { homeForRole, useAuth } from "../auth";
import { Button, FormField, LoadingBlock, Notice } from "../components/UI";
import { ThemeToggle } from "../theme";

function tokenFromHash() {
  const raw = window.location.hash.replace(/^#/, "");
  if (!raw) return "";
  const value = new URLSearchParams(raw).get("token");
  return value ?? decodeURIComponent(raw);
}

export function ActivatePage() {
  const token = useMemo(tokenFromHash, []);
  const navigate = useNavigate();
  const { setUser } = useAuth();
  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(Boolean(token));
  const [codeword, setCodeword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isStaff = preview?.role === "tutor";
  const minimumLength = isStaff ? 12 : 10;

  useEffect(() => {
    if (!token) return;
    api.auth.previewInvite(token)
      .then(setPreview)
      .catch((reason: unknown) => setPreviewError(reason instanceof Error ? reason.message : "Ссылка недействительна"))
      .finally(() => setPreviewLoading(false));
  }, [token]);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (codeword !== confirmation) {
      setError("Кодовые слова не совпадают");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await api.auth.activate(token, codeword, isStaff);
      window.history.replaceState(null, "", window.location.pathname);
      setUser(result.user);
      navigate(homeForRole(result.user.role), { replace: true });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Не удалось активировать аккаунт");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="auth-page">
      <ThemeToggle className="theme-toggle--floating" />
      <section className="auth-panel" aria-labelledby="activate-title">
        <div className="auth-brand"><span className="brand-mark" aria-hidden="true"><img src="/favicon.svg" alt="" /></span><span>Eduri</span></div>
        <div className="auth-heading">
          <h1 id="activate-title">Активация аккаунта</h1>
          <p>{isStaff ? "Задайте пароль, который будете использовать для входа." : "Задайте кодовое слово, которое будете использовать для входа."}</p>
        </div>

        {!token && <Notice type="error">В ссылке нет токена приглашения.</Notice>}
        {previewLoading && <LoadingBlock label="Проверяем приглашение" />}
        {previewError && <Notice type="error">{previewError}</Notice>}
        {preview && (
          <>
            <div className="invite-preview">
              <CheckCircle2 size={21} />
              <div><strong>{preview.displayName}</strong><span>{isStaff ? `Логин: ${preview.loginName ?? "—"}` : `Репетитор: ${preview.tutorName ?? "—"}`}</span></div>
            </div>
            <form className="form-stack" onSubmit={onSubmit}>
              <FormField label={isStaff ? "Пароль" : "Кодовое слово"} hint={isStaff ? "Минимум 12 символов. Не используйте пароль от других сервисов." : "Минимум 10 символов. Не используйте имя, простой цифровой код или распространённую фразу."}>
                <input type="password" minLength={minimumLength} value={codeword} onChange={(event) => setCodeword(event.target.value)} autoComplete="new-password" required autoFocus />
              </FormField>
              <FormField label={isStaff ? "Повторите пароль" : "Повторите кодовое слово"}>
                <input type="password" minLength={minimumLength} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} autoComplete="new-password" required />
              </FormField>
              {error && <Notice type="error">{error}</Notice>}
              <Button type="submit" disabled={submitting || codeword.length < minimumLength || !confirmation} icon={<KeyRound size={18} />}>
                {submitting ? "Активируем…" : "Активировать"}
              </Button>
            </form>
          </>
        )}
        {(previewError || !token) && <Link className="text-link" to="/login">Перейти ко входу</Link>}
      </section>
    </main>
  );
}
