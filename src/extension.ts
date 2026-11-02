/**
 * @file extension.ts
 * @description Точка входа расширения CodeStyle для Visual Studio Code.
 *
 * Этот файл «склеивает» логику проверки (checks.ts) с редактором:
 *   - показывает нарушения подчёркиванием и в панели Problems;
 *   - предлагает быстрые исправления (Ctrl+.);
 *   - регистрирует команды и горячие клавиши;
 *   - показывает оценку стиля в строке состояния (правый нижний угол).
 *
 * Как это работает: VS Code вызывает функцию activate() один раз, когда
 * пользователь открывает файл C/C++. Внутри мы подписываемся на события
 * редактора (открытие и изменение файла) и регистрируем команды.
 */
import * as vscode from 'vscode';
import { check, applyEdits, score, toSnake, Issue } from './checks';

/** Название источника, которое видно в подсказке и в панели Problems. */
const SOURCE = 'Code Style Linter';

/** Коллекция «предупреждений» — именно из неё VS Code рисует волнистые подчёркивания. */
const diagnostics = vscode.languages.createDiagnosticCollection('codestyle');

/** Элемент строки состояния (правый нижний угол), где показывается оценка в процентах. */
const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
statusBar.command = 'codestyle.score';   // по щелчку на проценте запускается команда показа оценки

/**
 * Проверяет, что документ — файл на C или C++.
 *
 * @param {vscode.TextDocument} doc - открытый в редакторе документ
 * @returns {boolean} true, если это C или C++
 */
const isCpp = (doc: vscode.TextDocument): boolean => doc.languageId === 'c' || doc.languageId === 'cpp';

/**
 * Возвращает активный (текущий) редактор, но только если в нём открыт файл C/C++.
 *
 * @returns {vscode.TextEditor | undefined} редактор или undefined, если файл другого типа / ничего не открыто
 */
const activeCpp = (): vscode.TextEditor | undefined => {
  const ed = vscode.window.activeTextEditor;
  return ed && isCpp(ed.document) ? ed : undefined;
};
// ===================================================================
// Проверка документа
// ===================================================================

/**
 * Проверяет документ и считает оценку стиля.
 *
 * @param {vscode.TextDocument} doc - проверяемый документ
 * @returns {{issues: Issue[], lines: number, percent: number}} нарушения, количество строк
 *          (0 для пустого файла) и оценка в процентах (0–100)
 */
function analyze(doc: vscode.TextDocument) {
  const text = doc.getText();
  const lines = text === '' ? 0 : doc.lineCount;   // пустой файл считаем за 0 строк
  const issues = check(text);
  return { issues, lines, percent: score(issues.length, lines) };
}

/**
 * Обновляет подчёркивания, панель Problems и оценку в строке состояния.
 * Вызывается при открытии файла и после каждого изменения текста;
 * старые предупреждения при этом заменяются новыми (дубликатов не бывает).
 *
 * @param {vscode.TextDocument} doc - документ, который нужно перепроверить
 */
function refresh(doc: vscode.TextDocument) {
  if (!isCpp(doc)) return;   // файлы других языков не трогаем
  const { issues, percent } = analyze(doc);

  // Превращаем наши нарушения (Issue) в «предупреждения» VS Code (Diagnostic)
  diagnostics.set(doc.uri, issues.map(i => {
    const range = new vscode.Range(i.line, i.start, i.line, i.end);   // что подчеркнуть
    const d = new vscode.Diagnostic(range, i.message, vscode.DiagnosticSeverity.Warning);
    d.source = SOURCE;   // «Code Style Linter»
    d.code = i.rule;     // naming / indentation / spacing / braces
    return d;
  }));

  // Процент показываем, только если это файл, который сейчас открыт на экране
  if (vscode.window.activeTextEditor?.document.uri.toString() === doc.uri.toString()) {
    statusBar.text = `$(checklist) Стиль: ${percent}%`;
    statusBar.show();
  }
}
// ===================================================================
// Переименование через языковой сервер C/C++
// ===================================================================

/**
 * Переименовывает имя с помощью языкового сервера C/C++ (расширение Microsoft C/C++).
 * Сервер знает области видимости, поэтому комментарии, строки и одноимённые
 * переменные в других функциях не затрагиваются (простая замена текста запрещена).
 *
 * @param {vscode.Uri} uri - адрес (путь) файла
 * @param {vscode.Position} pos - позиция на любом символе переименовываемого имени
 * @param {string} newName - новое имя
 * @returns {Promise<boolean>} true — переименование выполнено; false — сервера нет или он отказал
 */
async function rename(uri: vscode.Uri, pos: vscode.Position, newName: string): Promise<boolean> {
  try {
    // Просим языковой сервер подготовить набор правок для переименования
    const edit = await vscode.commands.executeCommand<vscode.WorkspaceEdit>(
      'vscode.executeDocumentRenameProvider', uri, pos, newName);
    if (edit && edit.size > 0) return await vscode.workspace.applyEdit(edit);   // применяем правки
  } catch {
    // Сервера нет или он вернул ошибку — просто сообщим о неудаче через return false
  }
  return false;
}

/** Сообщение, которое показывается, если переименовать не удалось. */
const NO_SERVER = 'Не удалось переименовать: нужен языковой сервер C/C++ (расширение «C/C++» от Microsoft).';