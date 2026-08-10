import { lazy, Suspense } from "react";
import { Navigate, Route, Routes } from "react-router-dom";
import { ProtectedRoute } from "./auth";
import { Shell } from "./components/Shell";
import { LoadingBlock } from "./components/UI";
import { ActivatePage } from "./pages/ActivatePage";
import { LoginPage } from "./pages/LoginPage";
import { TutorsPage } from "./pages/admin/TutorsPage";
import { StudentAssignmentsPage } from "./pages/student/StudentAssignmentsPage";
import { StudentMaterialsPage } from "./pages/student/StudentMaterialsPage";
import { StudentTodayPage } from "./pages/student/StudentTodayPage";
import { MaterialsPage } from "./pages/tutor/MaterialsPage";
import { StudentDetailPage } from "./pages/tutor/StudentDetailPage";
import { StudentsPage } from "./pages/tutor/StudentsPage";
import { TutorAssignmentsPage } from "./pages/tutor/TutorAssignmentsPage";
import { TutorTodayPage } from "./pages/tutor/TutorTodayPage";
import { PublicHomePage } from "./pages/PublicHomePage";

const LessonPage = lazy(() => import("./pages/LessonPage").then((module) => ({ default: module.LessonPage })));
const SoloBoardPage = lazy(() => import("./pages/SoloBoardPage").then((module) => ({ default: module.SoloBoardPage })));
const SoloCodePage = lazy(() => import("./pages/SoloCodePage").then((module) => ({ default: module.SoloCodePage })));
const GuestRoomPage = lazy(() => import("./pages/GuestRoomPage").then((module) => ({ default: module.GuestRoomPage })));

function PublicLoading() {
  return <div className="app-loading"><span className="spinner" /></div>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/activate" element={<ActivatePage />} />
      <Route path="/board" element={<Suspense fallback={<PublicLoading />}><SoloBoardPage /></Suspense>} />
      <Route path="/code" element={<Suspense fallback={<PublicLoading />}><SoloCodePage /></Suspense>} />
      <Route path="/room/:shareId/:resourceKind?" element={<Suspense fallback={<PublicLoading />}><GuestRoomPage /></Suspense>} />

      <Route element={<ProtectedRoute roles={["tutor"]} />}>
        <Route element={<Shell />}>
          <Route path="/tutor" element={<TutorTodayPage />} />
          <Route path="/tutor/students" element={<StudentsPage />} />
          <Route path="/tutor/students/:studentId" element={<StudentDetailPage />} />
          <Route path="/tutor/materials" element={<MaterialsPage />} />
          <Route path="/tutor/assignments" element={<TutorAssignmentsPage />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute roles={["student"]} />}>
        <Route element={<Shell />}>
          <Route path="/student" element={<StudentTodayPage />} />
          <Route path="/student/assignments" element={<StudentAssignmentsPage />} />
          <Route path="/student/materials" element={<StudentMaterialsPage />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute roles={["admin"]} />}>
        <Route element={<Shell />}>
          <Route path="/admin/tutors" element={<TutorsPage />} />
        </Route>
      </Route>

      <Route element={<ProtectedRoute />}>
        <Route path="/lesson/:lessonId" element={<Suspense fallback={<div className="lesson-loading"><LoadingBlock label="Загружаем урок" /></div>}><LessonPage /></Suspense>} />
      </Route>
      <Route path="/" element={<PublicHomePage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
