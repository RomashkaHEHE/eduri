import { loader } from "@monaco-editor/react";

export const MONACO_RUNTIME_BASE_URL =
  "/vendor/monaco-editor/0.55.1/vs";

export function configureMonacoRuntime(): void {
  loader.config({ paths: { vs: MONACO_RUNTIME_BASE_URL } });
}
