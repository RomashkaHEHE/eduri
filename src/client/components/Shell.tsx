import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  Bell,
  BookOpen,
  CalendarDays,
  ClipboardCheck,
  GraduationCap,
  Home,
  LogOut,
  Menu,
  Settings,
  ShieldCheck,
  Users,
  X,
} from "lucide-react";
import type { Role } from "../../shared/types";
import { useAuth } from "../auth";
import { ThemeToggle } from "../theme";
import { IconButton, initials } from "./UI";

interface NavItem {
  to: string;
  label: string;
  icon: typeof Home;
  end?: boolean;
}

const tutorNav: NavItem[] = [
  { to: "/tutor", label: "Сегодня", icon: Home, end: true },
  { to: "/tutor/students", label: "Ученики", icon: Users },
  { to: "/tutor/materials", label: "Материалы", icon: BookOpen },
  { to: "/tutor/assignments", label: "Домашние", icon: ClipboardCheck },
];

const studentNav: NavItem[] = [
  { to: "/student", label: "Сегодня", icon: Home, end: true },
  { to: "/student/assignments", label: "Домашние", icon: ClipboardCheck },
  { to: "/student/materials", label: "Материалы", icon: BookOpen },
];

const adminNav: NavItem[] = [
  { to: "/admin/tutors", label: "Репетиторы", icon: ShieldCheck },
];

function navForRole(role: Role) {
  if (role === "tutor") return tutorNav;
  if (role === "student") return studentNav;
  return adminNav;
}

const roleLabels: Record<Role, string> = {
  admin: "Администратор",
  tutor: "Репетитор",
  student: "Ученик",
};

export function Shell() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigation = user ? navForRole(user.role) : [];
  const activePage = [...navigation].reverse().find((item) =>
    item.end ? location.pathname === item.to : location.pathname.startsWith(item.to),
  );

  useEffect(() => {
    setMenuOpen(false);
  }, [location.pathname]);

  if (!user) return null;

  const onLogout = async () => {
    await logout();
    navigate("/login", { replace: true });
  };

  return (
    <div className="app-shell">
      <header className="mobile-header">
        <IconButton label="Открыть навигацию" onClick={() => setMenuOpen(true)}>
          <Menu size={21} />
        </IconButton>
        <span className="mobile-header__title">{activePage?.label ?? "Eduri"}</span>
        <IconButton label="Уведомления"><Bell size={20} /></IconButton>
      </header>

      {menuOpen && <button className="sidebar-backdrop" aria-label="Закрыть навигацию" onClick={() => setMenuOpen(false)} />}
      <aside className={`sidebar ${menuOpen ? "sidebar--open" : ""}`}>
        <div className="sidebar__brand">
          <span className="brand-mark"><GraduationCap size={22} /></span>
          <span className="brand-name">Eduri</span>
          <IconButton label="Закрыть навигацию" className="sidebar__close" onClick={() => setMenuOpen(false)}>
            <X size={20} />
          </IconButton>
        </div>

        <nav className="sidebar__nav" aria-label="Основная навигация">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink key={to} to={to} end={end} className={({ isActive }) => `nav-link ${isActive ? "nav-link--active" : ""}`}>
              <Icon size={19} strokeWidth={1.9} />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar__lower">
          <ThemeToggle variant="nav" />
          <button className="nav-link" type="button" disabled>
            <CalendarDays size={19} /><span>Расписание</span>
          </button>
          <button className="nav-link" type="button" disabled>
            <Settings size={19} /><span>Настройки</span>
          </button>
        </div>

        <div className="account-menu">
          <span className="avatar avatar--small">{initials(user.displayName)}</span>
          <span className="account-menu__text">
            <strong>{user.displayName}</strong>
            <small>{roleLabels[user.role]}</small>
          </span>
          <IconButton label="Выйти" onClick={onLogout}><LogOut size={18} /></IconButton>
        </div>
      </aside>

      <main className="app-main">
        <Outlet />
      </main>
    </div>
  );
}
