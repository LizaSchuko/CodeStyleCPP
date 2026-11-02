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

// ===================================================================
// Быстрые исправления (Quick Fix, Ctrl+.)
// ===================================================================

/** Названия пунктов меню Quick Fix для каждого правила. */
const TITLES: Record<string, string> = {
  indentation: 'Исправить отступ',
  spacing: 'Поставить пробелы',
  braces: 'Добавить фигурные скобки',
};

/**
 * Поставщик быстрых исправлений. VS Code сам вызывает provideCodeActions,
 * когда пользователь нажимает Ctrl+. или на лампочку рядом с предупреждением.
 */
class Fixer implements vscode.CodeActionProvider {
  /**
   * Для каждого нашего предупреждения строит пункт меню «Исправить…».
   *
   * @param {vscode.TextDocument} doc - документ, в котором открыто меню
   * @param {vscode.Range} _range - выделенный диапазон (не используется)
   * @param {vscode.CodeActionContext} ctx - контекст: список предупреждений под курсором
   * @returns {vscode.CodeAction[]} список пунктов меню (может быть пустым)
   */
  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const issues = check(doc.getText());      // свежий список нарушений
    const actions: vscode.CodeAction[] = [];

    for (const d of ctx.diagnostics) {
      if (d.source !== SOURCE) continue;      // чужие предупреждения не обрабатываем

      // Находим наше нарушение, которое соответствует этому предупреждению (по позиции и правилу)
      const issue = issues.find(i =>
        i.line === d.range.start.line && i.start === d.range.start.character && i.rule === d.code);
      if (!issue) continue;

      let action: vscode.CodeAction | undefined;
      if (issue.newName) {
        // Нарушение имени: пункт меню запускает переименование через языковой сервер
        action = new vscode.CodeAction(
          `Переименовать «${doc.getText(d.range)}» в «${issue.newName}»`, vscode.CodeActionKind.QuickFix);
        action.command = { title: 'Переименовать', command: 'codestyle.renameAt', arguments: [doc.uri, d.range.start, issue.newName] };
      } else if (issue.edits) {
        // Нарушение, которое исправляется правкой текста
        action = new vscode.CodeAction(TITLES[issue.rule], vscode.CodeActionKind.QuickFix);
        action.edit = new vscode.WorkspaceEdit();
        for (const e of issue.edits) {
          action.edit.replace(doc.uri, new vscode.Range(e.line, e.start, e.line, e.end), e.text);
        }
      }
      // Если исправление небезопасно (например, сложный if без скобок), пункта в меню просто не будет
      if (action) {
        action.diagnostics = [d];   // связываем пункт с конкретным предупреждением
        actions.push(action);
      }
    }
    return actions;
  }
}
// ===================================================================
// Активация расширения
// ===================================================================

/**
 * Точка входа: VS Code вызывает эту функцию один раз при первом открытии файла C/C++.
 * Здесь регистрируются все команды и подписки на события редактора.
 *
 * @param {vscode.ExtensionContext} ctx - контекст расширения; всё, что мы в него добавляем
 *        (ctx.subscriptions), VS Code автоматически «выключит» при отключении расширения
 */
export function activate(ctx: vscode.ExtensionContext) {
  /**
   * Короткая запись для регистрации команды.
   * @param {string} id - идентификатор команды (как в package.json)
   * @param {(...args: any[]) => any} fn - функция, которая выполняется при вызове команды
   */
  const reg = (id: string, fn: (...args: any[]) => any) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  const info = vscode.window.showInformationMessage;   // короткое имя для показа сообщений

  // ---------- Ctrl+Alt+L: привести файл в порядок ----------
  reg('codestyle.format', async () => {
    const ed = activeCpp();
    if (!ed) return;
    const doc = ed.document;
    const text = doc.getText();

    // Шаг 1. Исправляем пробелы, фигурные скобки и отступы.
    // Правки применяем к тексту в памяти, затем заменяем документ одним действием
    // (так одна отмена Ctrl+Z возвращает всё назад).
    const fixed = applyEdits(text, check(text).flatMap(i => i.edits ?? []));
    if (fixed !== text) {
      await ed.edit(b => b.replace(doc.validateRange(new vscode.Range(0, 0, doc.lineCount, 0)), fixed));
    }

    // Шаг 2. Переименовываем имена по одному, после каждого — повторная проверка.
    await new Promise(r => setTimeout(r, 1000));   // небольшая пауза: даём языковому серверу перечитать файл
    let renamed = 0;                               // сколько имён переименовали
    const tried = new Set<string>();               // позиции, которые уже пытались переименовать (чтобы не зациклиться)
    for (;;) {
      const next: Issue | undefined = check(doc.getText())
        .find(i => i.newName && !tried.has(`${i.line}:${i.start}`));
      if (!next) break;                            // непроверенных имён не осталось
      tried.add(`${next.line}:${next.start}`);
      if (await rename(doc.uri, new vscode.Position(next.line, next.start), next.newName!)) renamed++;
    }

    // Итог
    refresh(doc);
    const left = analyze(doc).issues.length;       // сколько нарушений осталось
    const note = renamed === 0 && tried.size > 0 ? ' Языковой сервер C/C++ недоступен — имена не переименованы.' : '';
    info(`Готово. Переименовано имён: ${renamed}. Осталось нарушений: ${left}.${note}`);
  });

  // ---------- Ctrl+Alt+K: проверить без изменений ----------
  reg('codestyle.check', async () => {
    const ed = activeCpp();
    if (!ed) return;
    refresh(ed.document);
    const n = analyze(ed.document).issues.length;
    if (n === 0) { info('Нарушений не найдено'); return; }
    vscode.window.showWarningMessage(`Найдено нарушений: ${n}`);
    await vscode.commands.executeCommand('workbench.actions.view.problems');   // открываем панель Problems
  });

  // ---------- Ctrl+Alt+S: показать оценку ----------
  reg('codestyle.score', () => {
    const ed = activeCpp();
    if (!ed) return;
    const { issues, lines, percent } = analyze(ed.document);
    info(`Оценка стиля: ${percent}% (нарушений: ${issues.length}, строк: ${lines}). ` +
      'Оценка отражает только реализованные проверки стиля, а не качество и корректность программы.');
  });

  // ---------- Ctrl+Alt+R: отчёт в формате Markdown ----------
  reg('codestyle.report', async () => {
    const ed = activeCpp();
    if (!ed) return;
    const { issues, lines, percent } = analyze(ed.document);

    // Таблица нарушений (или фраза «Проблем не обнаружено»)
    const table = issues.length
      ? ['| № | Строка | Категория | Описание |', '|---|---|---|---|',
         ...issues.map((i, k) => `| ${k + 1} | ${i.line + 1} | ${i.rule} | ${i.message} |`)]
      : ['Проблем не обнаружено'];

    const md = ['# Отчёт CodeStyle', '',
      `- Файл: ${ed.document.fileName}`, `- Строк: ${lines}`,
      `- Нарушений: ${issues.length}`, `- Оценка: ${percent}%`, '', ...table].join('\n');

    // Стандартный диалог «Сохранить как»
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(ed.document.fileName + '.report.md'), filters: { Markdown: ['md'] } });
    if (!uri) return;   // пользователь нажал «Отмена» — ничего не сохраняем
    await vscode.workspace.fs.writeFile(uri, Buffer.from(md, 'utf8'));
    info('Отчёт сохранён');
  });

  // ---------- Переименовать переменную в snake_case (курсор на имени) ----------
  reg('codestyle.rename', async () => {
    const ed = activeCpp();
    if (!ed) return;
    const range = ed.document.getWordRangeAtPosition(ed.selection.active);   // слово под курсором
    if (!range) { info('Поставьте курсор на имя переменной'); return; }
    const old = ed.document.getText(range);
    // Показываем окно ввода с предложенным именем в snake_case; пользователь может его изменить
    const name = await vscode.window.showInputBox({ prompt: `Новое имя для «${old}»`, value: toSnake(old) });
    if (name && name !== old && !(await rename(ed.document.uri, range.start, name))) {
      vscode.window.showWarningMessage(NO_SERVER);
    }
  });

  // ---------- Внутренняя команда: переименование из меню Quick Fix ----------
  reg('codestyle.renameAt', async (uri: vscode.Uri, pos: vscode.Position, name: string) => {
    if (!(await rename(uri, pos, name))) vscode.window.showWarningMessage(NO_SERVER);
  });

  // ---------- Подписки на события редактора ----------
  ctx.subscriptions.push(
    diagnostics, statusBar,
    // Меню быстрых исправлений для C и C++
    vscode.languages.registerCodeActionsProvider(['c', 'cpp'], new Fixer(),
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    // Файл открыт → проверяем
    vscode.workspace.onDidOpenTextDocument(refresh),
    // Текст изменился → проверяем заново
    vscode.workspace.onDidChangeTextDocument(e => refresh(e.document)),
    // Файл закрыт → убираем его предупреждения
    vscode.workspace.onDidCloseTextDocument(d => diagnostics.delete(d.uri)),
    // Переключились на другую вкладку → обновляем процент (или прячем, если это не C/C++)
    vscode.window.onDidChangeActiveTextEditor(e => {
      if (e && isCpp(e.document)) refresh(e.document); else statusBar.hide();
    }),
  );

  // Проверяем файлы, которые уже были открыты до активации расширения
  vscode.workspace.textDocuments.forEach(d => refresh(d));
}
/**
 * Вызывается VS Code при выключении расширения. Освобождать вручную нечего:
 * всё, что мы зарегистрировали, лежит в ctx.subscriptions и очищается автоматически.
 *
 * @returns {void} ничего не возвращает
 */
export function deactivate() {}