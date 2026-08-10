import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const boardRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const portableDirectories = ["core", "protocol", "persistence"] as const;
const forbiddenPackagePrefixes = [
  "@excalidraw/",
  "konva",
  "pixi.js",
  "react",
  "react-dom",
  "socket.io",
  "socket.io-client",
  "ws",
  "y-indexeddb",
] as const;
const forbiddenPlatformGlobals = new Set([
  "Blob",
  "Document",
  "File",
  "HTMLElement",
  "HTMLCanvasElement",
  "WebSocket",
  "Window",
  "indexedDB",
  "navigator",
  "window",
]);

function productionModuleFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return productionModuleFiles(entryPath);
    if (
      !entry.isFile()
      || !entry.name.endsWith(".ts")
      || entry.name.endsWith(".test.ts")
    ) {
      return [];
    }
    return [entryPath];
  });
}

function importedModuleNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  sourceFile.forEachChild((node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      && node.moduleSpecifier
      && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      names.push(node.moduleSpecifier.text);
    }
  });
  return names;
}

describe("Board core portability boundary", () => {
  it("does not acquire renderer, browser storage, transport, or Node dependencies", () => {
    const files = portableDirectories.flatMap((directory) =>
      productionModuleFiles(path.join(boardRoot, directory))
    );
    const sourceFiles = files.map((file) =>
      ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      )
    );
    const forbiddenImports = sourceFiles.flatMap((sourceFile) =>
      importedModuleNames(sourceFile)
        .filter((moduleName) =>
          moduleName.startsWith("node:")
          || forbiddenPackagePrefixes.some((prefix) =>
            prefix.endsWith("/")
              ? moduleName.startsWith(prefix)
              : moduleName === prefix || moduleName.startsWith(`${prefix}/`)
          )
        )
        .map((moduleName) => `${sourceFile.fileName}: ${moduleName}`)
    );

    expect(forbiddenImports).toEqual([]);
  });

  it("keeps production relative imports valid after native ESM compilation", () => {
    const files = portableDirectories.flatMap((directory) =>
      productionModuleFiles(path.join(boardRoot, directory))
    );
    const invalidSpecifiers = files.flatMap((file) => {
      const sourceFile = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      return importedModuleNames(sourceFile)
        .filter((moduleName) =>
          moduleName.startsWith(".") && !moduleName.endsWith(".js")
        )
        .map((moduleName) => `${path.relative(boardRoot, file)}: ${moduleName}`);
    });

    expect(invalidSpecifiers).toEqual([]);
  });

  it("does not reference browser-only global implementations", () => {
    const configPath = ts.findConfigFile(boardRoot, ts.sys.fileExists, "tsconfig.json");
    expect(configPath).toBeDefined();
    const config = ts.readConfigFile(configPath!, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(
      config.config,
      ts.sys,
      path.dirname(configPath!),
    );
    const files = portableDirectories.flatMap((directory) =>
      productionModuleFiles(path.join(boardRoot, directory))
    );
    const program = ts.createProgram(files, parsed.options);
    const checker = program.getTypeChecker();
    const violations: string[] = [];

    for (const directory of portableDirectories) {
      const directoryPath = path.join(boardRoot, directory);
      for (const file of productionModuleFiles(directoryPath)) {
        const sourceFile = program.getSourceFile(file);
        expect(sourceFile, `TypeScript program did not contain ${file}`)
          .toBeDefined();
        const visit = (node: ts.Node): void => {
          if (
            ts.isIdentifier(node)
            && forbiddenPlatformGlobals.has(node.text)
          ) {
            const declarations = checker.getSymbolAtLocation(node)
              ?.getDeclarations();
            if (
              declarations
              && declarations.length > 0
              && declarations.every((declaration) =>
                declaration.getSourceFile().isDeclarationFile
              )
            ) {
              const position = sourceFile!.getLineAndCharacterOfPosition(
                node.getStart(sourceFile),
              );
              violations.push(
                `${path.relative(boardRoot, file)}:${position.line + 1} ${node.text}`,
              );
            }
          }
          ts.forEachChild(node, visit);
        };
        ts.forEachChild(sourceFile!, visit);
      }
    }

    expect(violations).toEqual([]);
  });
});
