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