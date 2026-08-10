import { useEffect, useLayoutEffect, useRef, useState } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import { LoaderCircle, Play } from "lucide-react";
import { Button } from "./UI";
import {
  startPythonRun,
  type PythonRunHandle,
} from "../pythonRunner";
import { useOptionalTheme } from "../theme";
import "./CodeWorkspace.css";

interface LessonCodeWorkspaceProps {
  readonly code: string;
  readonly onCodeChange: (value: string | undefined) => void;
}

export function LessonCodeWorkspace({
  code,
  onCodeChange,
}: LessonCodeWorkspaceProps) {
  const theme = useOptionalTheme()?.theme ?? "light";
  const editorTheme = theme === "dark" ? "vs-dark" : "vs";
  const [output, setOutput] = useState(
    "Нажмите «Запустить», чтобы увидеть результат.",
  );
  const [running, setRunning] = useState(false);
  const activeRun = useRef<PythonRunHandle | null>(null);
  const monacoRef = useRef<Parameters<OnMount>[1] | null>(null);
  const editorThemeRef = useRef(editorTheme);
  const mounted = useRef(false);

  editorThemeRef.current = editorTheme;

  useLayoutEffect(() => {
    monacoRef.current?.editor.setTheme(editorTheme);
  }, [editorTheme]);

  const handleEditorMount: OnMount = (_editor, monaco) => {
    monacoRef.current = monaco;
    monaco.editor.setTheme(editorThemeRef.current);
  };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      monacoRef.current = null;
      activeRun.current?.cancel();
      activeRun.current = null;
    };
  }, []);

  const runCode = async () => {
    if (running || activeRun.current) return;
    setRunning(true);
    setOutput("Загружаем Python и выполняем программу…");
    const execution = startPythonRun({ kind: "script", code });
    activeRun.current = execution;
    try {
      const result = await execution.result;
      if (mounted.current && result.status !== "cancelled") {
        setOutput(result.output);
      }
    } finally {
      if (activeRun.current === execution) activeRun.current = null;
      if (mounted.current) setRunning(false);
    }
  };

  return (
    <div className="lesson-code-workspace" data-code-theme={theme}>
      <div className="code-toolbar">
        <div
          className="language-switch"
          aria-label="Язык программирования: Python"
        >
          <button
            type="button"
            className="is-active"
            disabled
          >
            Python
          </button>
        </div>
        <Button
          size="small"
          icon={
            running
              ? <LoaderCircle className="spin" size={16} />
              : <Play size={16} />
          }
          onClick={() => void runCode()}
          disabled={running}
        >
          {running ? "Выполняется" : "Запустить"}
        </Button>
      </div>
      <div className="code-editor">
        <Editor
          onMount={handleEditorMount}
          language="python"
          value={code}
          onChange={onCodeChange}
          theme={editorTheme}
          options={{
            automaticLayout: true,
            minimap: { enabled: false },
            fontSize: 14,
            lineHeight: 22,
            tabSize: 2,
            scrollBeyondLastLine: false,
            padding: { top: 14 },
            ariaLabel: "Совместный редактор кода",
          }}
        />
      </div>
      <div className="code-output">
        <div className="code-output__head">
          <strong>Результат</strong>
          {output && <button onClick={() => setOutput("")}>Очистить</button>}
        </div>
        <pre>{output || "Результат выполнения появится здесь."}</pre>
      </div>
    </div>
  );
}
