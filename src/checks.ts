/**
 * @file checks.ts
 * @description Вся логика проверки стиля кода C/C++.
 *
 * Этот файл НЕ зависит от VS Code: на вход приходит обычный текст программы,
 * на выходе — список нарушений (Issue). Благодаря этому логику можно
 * запускать и проверять отдельно от редактора.
 *
 * Общая идея работы:
 *   1. Текст делится на строки.
 *   2. Из строк «вырезаются» комментарии, содержимое строк в кавычках и
 *      директивы препроцессора (#include и т.п.) — их проверять не нужно.
 *   3. Четыре проверки (отступы, пробелы, скобки, имена) ищут нарушения
 *      и складывают их в общий список.
 */

// ===================================================================
// Типы данных
// ===================================================================

/** Название правила, которое нарушено (показывается в панели Problems). */
export type Rule = 'naming' | 'indentation' | 'spacing' | 'braces';

/**
 * Одна правка текста внутри ОДНОЙ строки: символы с номера start до end
 * (end не включается) заменяются на text.
 * Если start === end, то это просто вставка текста в позицию start.
 */
export interface Edit {
  line: number;   // номер строки, считая с нуля (первая строка файла = 0)
  start: number;  // номер символа в строке, с которого начинается замена
  end: number;    // номер символа, на котором замена заканчивается
  text: string;   // на что заменяем (может быть пустой строкой — тогда это удаление)
}

/** Одно найденное нарушение стиля. */
export interface Issue {
  line: number;       // номер строки (с нуля), где найдено нарушение
  start: number;      // номер символа, с которого подчёркиваем
  end: number;        // номер символа, на котором подчёркивание заканчивается
  rule: Rule;         // какое правило нарушено
  message: string;    // понятное описание нарушения для пользователя
  edits?: Edit[];     // как исправить правкой текста (отступы, пробелы, скобки)
  newName?: string;   // как исправить переименованием (только для имён)
}

// ===================================================================
// 1. Подготовка текста: «закрашиваем» то, что проверять не нужно
// ===================================================================

/**
 * Заменяет пробелами всё, что проверять не нужно: комментарии,
 * содержимое строк в кавычках и директивы препроцессора (#include, #define).
 * Длина каждой строки при этом не меняется, поэтому номера символов
 * в «закрашенной» и в настоящей строке совпадают.
 *
 * Параметры:
 *     lines (string[]): строки исходного файла (без символов переноса)
 *
 * Возвращаемое значение:
 *     результат (string[]): те же строки, но с «закрашенными» комментариями и строками
 *
 * Пример вызова:
 *     maskLines(['int a = 1; // число']);   // → ['int a = 1;          ']
 *     maskLines(['s = "a=b";']);            // → ['s = "   ";']  (кавычки остаются)
 */
function maskLines(lines: string[]): string[] {
  let inBlock = false;   // true, если мы сейчас внутри многострочного комментария /* ... */
  let inMacro = false;   // true, если прошлая строка #define закончилась символом \ (перенос)

  return lines.map(line => {
    // Директива препроцессора (строка начинается с #) или продолжение многострочного #define:
    // закрашиваем всю строку целиком.
    if (inMacro || (!inBlock && line.trim().startsWith('#'))) {
      inMacro = line.trimEnd().endsWith('\\');
      return ' '.repeat(line.length);
    }

    let out = '';       // сюда собираем «закрашенную» версию строки
    let quote = '';     // какая кавычка сейчас открыта: " или ' (пусто — мы не в кавычках)

    // Идём по строке символ за символом
    for (let i = 0; i < line.length; i++) {
      const c = line[i];          // текущий символ
      const next = line[i + 1];   // следующий символ (может быть undefined в конце строки)

      if (inBlock) {
        // Мы внутри /* ... */: ищем конец комментария */
        if (c === '*' && next === '/') { inBlock = false; out += '  '; i++; }
        else out += ' ';
      } else if (quote) {
        // Мы внутри строки или символа в кавычках
        if (c === '\\') { out += next === undefined ? ' ' : '  '; i++; }  // \" или \n — пропускаем оба символа
        else if (c === quote) { quote = ''; out += c; }                   // закрывающая кавычка остаётся на месте
        else out += ' ';                                                  // содержимое кавычек — в пробелы
      } else if (c === '/' && next === '/') {
        // Однострочный комментарий: всё до конца строки закрашиваем
        out += ' '.repeat(line.length - i);
        break;
      } else if (c === '/' && next === '*') {
        // Начало многострочного комментария
        inBlock = true; out += '  '; i++;
      } else if (c === '"' || c === "'") {
        // Открылась кавычка
        quote = c; out += c;
      } else {
        out += c;   // обычный символ кода — оставляем как есть
      }
    }
    return out;
  });
}

/**
 * Находит закрывающую скобку ')' для открывающей '(' в заданной позиции.
 * Учитывает вложенные скобки: в "f(a(b))" для первой '(' вернёт позицию последней ')'.
 *
 * Параметры:
 *     s (string): строка, в которой ищем
 *     open (number): номер символа, где стоит открывающая скобка '('
 *
 * Возвращаемое значение:
 *     результат (number): номер символа закрывающей ')' или -1, если на этой строке она не закрыта
 *
 * Пример вызова:
 *     findClose('if (a) b;', 3);   // → 5
 *     findClose('if (a &&', 3);    // → -1  (скобка не закрыта)
 */
function findClose(s: string, open: number): number {
  let depth = 0;   // сколько скобок сейчас открыто
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')' && --depth === 0) return i;   // закрылась та самая скобка
  }
  return -1;
}

/**
 * Ищет ближайшую строку ниже заданной, в которой есть код
 * (пустые строки и строки, состоящие только из комментария, пропускаются).
 *
 * Параметры:
 *     masked (string[]): «закрашенные» строки файла (результат maskLines)
 *     n (number): номер строки, после которой начинаем поиск
 *
 * Возвращаемое значение:
 *     результат (number): номер найденной строки или -1, если кода дальше нет
 *
 * Пример вызова:
 *     nextCode(['if (x)', '', '  return;'], 0);   // → 2
 */
function nextCode(masked: string[], n: number): number {
  for (let i = n + 1; i < masked.length; i++) {
    if (masked[i].trim() !== '') return i;
  }
  return -1;
}

// ===================================================================
// 2. Проверка отступов (правило indentation)
// ===================================================================

/**
 * Пересчитывает отступ строки «с нуля»: считает его ширину в колонках
 * (табуляция = 4 колонки), округляет до целого числа уровней и записывает
 * заново — либо табами, либо пробелами (смотря чем начинался старый отступ).
 * Повторный вызов на уже исправленном отступе ничего не меняет.
 *
 * Параметры:
 *     ws (string): отступ строки (пробелы и табуляции в её начале)
 *
 * Возвращаемое значение:
 *     результат (string): исправленный отступ: только табы или только пробелы (кратно 4)
 *
 * Пример вызова:
 *     fixIndent('      ');    // 6 пробелов → '        ' (8 пробелов)
 *     fixIndent('\t ');       // таб и пробел → '\t'
 *     fixIndent('    ');      // → '    ' (уже правильно, не меняется)
 */
function fixIndent(ws: string): string {
  let width = 0;   // ширина отступа в колонках
  for (const c of ws) {
    // Табуляция сдвигает до ближайшего числа, кратного 4; пробел добавляет одну колонку
    width = c === '\t' ? (Math.floor(width / 4) + 1) * 4 : width + 1;
  }
  const levels = Math.round(width / 4);   // сколько «уровней» получилось
  return ws.startsWith('\t') ? '\t'.repeat(levels) : ' '.repeat(levels * 4);
}

/**
 * Проверяет отступы всех строк с кодом. Нарушением считается:
 *   - в одном отступе смешаны табуляции и пробелы;
 *   - отступ из пробелов в начале оператора не кратен 4.
 * Строки-продолжения (предыдущая строка закончилась на запятую, скобку,
 * знак операции) на кратность 4 не проверяются — там допустимо выравнивание.
 *
 * Параметры:
 *     lines (string[]): настоящие строки файла
 *     masked (string[]): те же строки с «закрашенными» комментариями
 *     issues (Issue[]): общий список нарушений, куда добавляются найденные
 *
 * Возвращаемое значение:
 *     нет (void): ничего не возвращает, а дописывает результат в issues
 *
 * Пример вызова:
 *     // файл: ['int main() {', '   int a;', '}']  → нарушение в строке 1 (3 пробела)
 */
function checkIndent(lines: string[], masked: string[], issues: Issue[]) {
  let prev = '';   // предыдущая строка с кодом (без пробелов по краям)

  masked.forEach((m, n) => {
    if (m.trim() === '') return;   // пустые строки, комментарии и #-строки пропускаем

    const ws = /^[ \t]*/.exec(lines[n])![0];   // отступ — пробелы/табы в начале строки
    const hasTab = ws.includes('\t');
    const hasSpace = ws.includes(' ');

    // Строка «продолжает» оператор, если предыдущая закончилась на , ( [ = + - * / и т.п.
    const isContinuation = /[,(\[=+\-*\/%&|^?]$/.test(prev);

    let message = '';   // текст нарушения; пустой — значит, всё в порядке
    if (hasTab && hasSpace) {
      message = 'В отступе смешаны табуляции и пробелы';
    } else if (!hasTab && hasSpace && ws.length % 4 !== 0 && !isContinuation) {
      message = 'Отступ из пробелов должен быть кратен 4';
    }

    if (message) {
      issues.push({
        line: n, start: 0, end: ws.length, rule: 'indentation', message,
        edits: [{ line: n, start: 0, end: ws.length, text: fixIndent(ws) }],   // исправление: заменить весь отступ
      });
    }
    prev = m.trim();
  });
}

// ===================================================================
// 3. Проверка пробелов (правило spacing)
// ===================================================================

/**
 * Регулярное выражение для поиска операторов в строке.
 * Длинные операторы стоят раньше коротких (иначе «==» распознается как два «=»).
 */
const OPS = /<=>|<<=|>>=|->|\+\+|--|<<|>>|&&|\|\||==|!=|<=|>=|[-+*\/%&|^]=|=|[-+\/%]/g;

/** Операторы, которые найдены регулярным выражением, но пробелов вокруг не требуют. */
const SKIP_OPS = new Set(['->', '++', '--', '<<', '>>', '<=>', '<<=', '>>=']);

/** Слова, после которых «+» и «-» — это знак числа (return -1), а не вычитание. */
const WORD_BEFORE_UNARY = new Set(['return', 'case', 'throw', 'else', 'operator', 'co_return', 'co_yield', 'delete']);

/**
 * Проверяет пробелы: вокруг операторов (=, +=, ==, &&, ||, +, -, /, % и др.),
 * после запятой и после «;» в заголовке цикла for.
 * Звёздочка *, амперсанд &, угловые скобки < > не проверяются
 * (они могут означать указатели, ссылки и шаблоны).
 *
 * Параметры:
 *     masked (string[]): «закрашенные» строки файла
 *     issues (Issue[]): общий список нарушений, куда добавляются найденные
 *
 * Возвращаемое значение:
 *     нет (void): ничего не возвращает, а дописывает результат в issues
 *
 * Пример вызова:
 *     // 'int a=5;'          → нарушение: нужны пробелы вокруг «=»
 *     // 'f(a,b);'           → нарушение: нужен пробел после запятой
 *     // 'for (i=0;i<n;i++)' → нарушения: «=» и два «;»
 */
function checkSpacing(masked: string[], issues: Issue[]) {
  masked.forEach((line, n) => {
    /**
     * Вспомогательная функция: добавляет нарушение «пробелов» в текущую строку.
     *
     * Параметры:
     *     start (number): начало подчёркивания в строке
     *     end (number): конец подчёркивания в строке
     *     message (string): описание нарушения
     *     text (string): на что заменить подчёркнутый кусок при исправлении
     *
     * Возвращаемое значение:
     *     результат (number): новая длина списка issues (результат push, не используется)
     *
     * Пример вызова:
     *     add(5, 6, 'Нужны пробелы вокруг «=»', ' = ');
     */
    const add = (start: number, end: number, message: string, text: string) =>
      issues.push({ line: n, start, end, rule: 'spacing', message, edits: [{ line: n, start, end, text }] });

    // ---- а) пробелы вокруг операторов ----
    for (const m of line.matchAll(OPS)) {
      const op = m[0];                  // найденный оператор, например "+="
      const i = m.index!;               // где он начинается
      const e = i + op.length;          // где заканчивается
      if (SKIP_OPS.has(op)) continue;   // -> ++ -- << >> пропускаем

      const before = line.slice(0, i);  // текст строки слева от оператора

      if (/\boperator\s*$/.test(before)) continue;   // operator== , operator+ — это имя функции, а не операция

      // Лямбда-захват [=] или [=, x] — это не присваивание
      if (op === '=' && /^\s*[\],]/.test(line.slice(e)) && /[\[,]\s*$/.test(before)) continue;

      // Для одиночных + - / % надо отличить вычитание от знака числа
      if (op.length === 1 && '+-/%'.includes(op)) {
        const left = before.trimEnd();                                   // текст слева без хвостовых пробелов
        if (!/[\w\]]$/.test(left)) continue;                              // слева не имя/число/] — это знак числа (x = -y) или скобка
        if (WORD_BEFORE_UNARY.has(/\w+$/.exec(left)?.[0] ?? '')) continue;   // return -1
        if ('+-'.includes(op) && /(^|[^\w.])\d[\w.]*[eE]$/.test(left)) continue;   // запись числа 1e-5
      }

      const leftOk = i === 0 || /\s/.test(line[i - 1]);              // слева есть пробел (или начало строки)
      const rightOk = e >= line.length || /\s/.test(line[e]);        // справа есть пробел (или конец строки)

      // «a&&b» — нарушение, а «T&& x» (ссылка) — нет, поэтому для && требуем отсутствие пробелов с обеих сторон
      const bad = op === '&&' ? !leftOk && !rightOk : !leftOk || !rightOk;

      if (bad) {
        // Исправление: добавляем только недостающие пробелы
        add(i, e, `Нужны пробелы вокруг «${op}»`, (leftOk ? '' : ' ') + op + (rightOk ? '' : ' '));
      }
    }

    // ---- б) пробел после запятой ----
    for (const m of line.matchAll(/,(?=\S)/g)) {   // запятая, за которой сразу идёт НЕ пробел
      if (/\boperator\s*$/.test(line.slice(0, m.index))) continue;   // operator, — имя функции
      add(m.index!, m.index! + 1, 'Нужен пробел после запятой', ', ');
    }

    // ---- в) пробел после «;» в заголовке for ----
    for (const m of line.matchAll(/\bfor\s*\(/g)) {
      const open = m.index! + m[0].length - 1;     // позиция открывающей скобки '('
      const close = findClose(line, open);         // позиция закрывающей ')'
      if (close < 0) continue;                     // заголовок на несколько строк — пропускаем
      for (let i = open + 1; i < close; i++) {
        // «;» без пробела после него (но «;;» и «;)» — это нормально)
        if (line[i] === ';' && !/[\s;)]/.test(line[i + 1])) add(i, i + 1, 'Нужен пробел после «;»', '; ');
      }
    }
  });
}

// ===================================================================
// 4. Проверка фигурных скобок (правило braces)
// ===================================================================

/** Ищет в строке слова if/for/while/switch со скобкой «(», а также слово else (но не «else if»). */
const BLOCK_RE = /\b(if|for|while|switch)\s*\(|\belse\b(?!\s+if\b)/g;

/**
 * Проверяет, что у if, else, for, while тело заключено в { }, а у switch есть блок { }.
 * Допустимо:
 *   - короткая запись в одну строку:  if (x) return;
 *   - открывающая скобка на следующей строке.
 * Нарушение: тело записано на следующей строке без скобок.
 * Автоисправление возможно, только если тело — ровно один простой оператор.
 *
 * Параметры:
 *     lines (string[]): настоящие строки файла (нужны, чтобы узнать отступ)
 *     masked (string[]): «закрашенные» строки файла
 *     issues (Issue[]): общий список нарушений, куда добавляются найденные
 *
 * Возвращаемое значение:
 *     нет (void): ничего не возвращает, а дописывает результат в issues
 *
 * Пример вызова:
 *     // if (x)            ← нарушение (подчёркнуто слово if)
 *     //     return 1;
 *     //
 *     // if (x) return 1;  ← нарушения нет (короткая запись в одну строку)
 */
function checkBraces(lines: string[], masked: string[], issues: Issue[]) {
  masked.forEach((line, n) => {
    for (const m of line.matchAll(BLOCK_RE)) {
      const word = m[1] ?? 'else';              // найденное слово: if / for / while / switch / else
      let after = m.index! + m[0].length;       // позиция сразу после слова

      if (word !== 'else') {
        // У if/for/while/switch после слова идёт условие в скобках — пропускаем его целиком
        const close = findClose(line, after - 1);
        if (close < 0) continue;                // условие занимает несколько строк — не трогаем
        after = close + 1;
      }

      const rest = line.slice(after).trim();    // что написано после заголовка на той же строке
      if (rest.startsWith('{')) continue;       // скобка на месте — всё хорошо

      const next = nextCode(masked, n);         // ближайшая строка с кодом ниже
      const bad = rest !== ''
        ? word === 'switch'                                            // «if (x) return;» допустимо, но у switch скобки обязательны
        : next >= 0 && !masked[next].trim().startsWith('{');           // тело на следующей строке и без «{»
      if (!bad) continue;

      const issue: Issue = {
        line: n, start: m.index!, end: m.index! + word.length, rule: 'braces',
        message: word === 'switch' ? 'У switch должен быть блок { }' : `Тело «${word}» должно быть заключено в { }`,
      };

      // Автоисправление — только если тело это один простой оператор на следующей строке
      if (word !== 'switch' && rest === '') {
        const body = masked[next].trim();   // строка с телом
        const isOneStatement = body.endsWith(';') && body.split(';').length === 2;   // ровно одна «;» в конце
        const isNested = /^(if|for|while|do|switch|try|else)\b/.test(body);         // тело начинается с вложенной конструкции
        if (isOneStatement && !isNested) {
          const indent = /^[ \t]*/.exec(lines[n])![0];       // отступ строки-заголовка
          const semi = masked[next].lastIndexOf(';');         // где стоит «;» в строке с телом
          issue.edits = [
            { line: n, start: after, end: after, text: ' {' },                           // дописать « {» после заголовка
            { line: next, start: semi + 1, end: semi + 1, text: '\n' + indent + '}' },   // дописать «}» после тела
          ];
        }
      }
      issues.push(issue);
    }
  });
}

// ===================================================================
// 5. Проверка имён (правило naming)
// ===================================================================

/** Вид проверяемого имени. */
type Kind = 'variable' | 'function' | 'type' | 'constant';

/** Для каждого вида имён: регулярное выражение «правильного имени» и название стиля. */
const STYLE: Record<Kind, { re: RegExp; title: string }> = {
  variable: { re: /^[a-z][a-z0-9]*(_[a-z0-9]+)*_?$/, title: 'snake_case' },   // user_name (в конце _ допустим)
  function: { re: /^[A-Z][A-Za-z0-9]*$/,             title: 'PascalCase' },   // CalculateSum
  type:     { re: /^[A-Z][A-Za-z0-9]*$/,             title: 'PascalCase' },   // UserData
  constant: { re: /^k[A-Z][A-Za-z0-9]*$/,            title: 'kPascalCase' },  // kMaxCount
};

/** Ключевые слова C/C++ (и main): они никогда не считаются нарушением имени. */
const KEYWORDS = new Set(['return', 'delete', 'new', 'throw', 'goto', 'case', 'else', 'using', 'typedef', 'namespace',
  'class', 'struct', 'enum', 'union', 'if', 'for', 'while', 'switch', 'do', 'sizeof', 'operator', 'co_return', 'co_await',
  'co_yield', 'template', 'typename', 'public', 'private', 'protected', 'friend', 'main', 'const', 'volatile', 'override',
  'final', 'noexcept', 'default', 'break', 'continue', 'try', 'catch']);

/**
 * Разбивает имя на отдельные слова (маленькими буквами).
 *
 * Параметры:
 *     name (string): исходное имя
 *
 * Возвращаемое значение:
 *     результат (string[]): список слов
 *
 * Пример вызова:
 *     words('userName');    // → ['user', 'name']
 *     words('MAX_COUNT');   // → ['max', 'count']
 *     words('HTTPServer');  // → ['http', 'server']
 */
function words(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')        // userName → user_Name
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')     // HTTPServer → HTTP_Server
    .split('_')                                    // режем по подчёркиваниям
    .filter(Boolean)                               // выкидываем пустые куски
    .map(w => w.toLowerCase());
}

/**
 * Переводит имя в PascalCase (каждое слово с большой буквы, без подчёркиваний).
 *
 * Параметры:
 *     name (string): исходное имя
 *
 * Возвращаемое значение:
 *     результат (string): имя в PascalCase
 *
 * Пример вызова:
 *     pascal('find_element');   // → 'FindElement'
 */
const pascal = (name: string): string => words(name).map(w => w[0].toUpperCase() + w.slice(1)).join('');

/**
 * Переводит имя в snake_case (слова маленькими буквами через «_»).
 * Если имя заканчивалось на «_» (поле класса), подчёркивание сохраняется.
 *
 * Параметры:
 *     name (string): исходное имя
 *
 * Возвращаемое значение:
 *     результат (string): имя в snake_case
 *
 * Пример вызова:
 *     toSnake('userName');    // → 'user_name'
 *     toSnake('ItemCount');   // → 'item_count'
 *     toSnake('Value_');      // → 'value_'
 */
export const toSnake = (name: string): string => words(name).join('_') + (name.endsWith('_') ? '_' : '');

/**
 * Проверяет одно имя; если оно написано не по правилам — добавляет нарушение.
 * Ключевые слова и имена, начинающиеся с «_», пропускаются.
 *
 * Параметры:
 *     issues (Issue[]): общий список нарушений
 *     line (number): номер строки, где стоит имя (с нуля)
 *     col (number): номер символа, с которого начинается имя
 *     name (string): само имя
 *     kind (Kind): что это за имя: 'variable' | 'function' | 'type' | 'constant'
 *
 * Возвращаемое значение:
 *     нет (void): ничего не возвращает, а дописывает результат в issues
 *
 * Пример вызова:
 *     checkName(issues, 0, 4, 'userName', 'variable');   // добавит нарушение, предложит 'user_name'
 */
function checkName(issues: Issue[], line: number, col: number, name: string, kind: Kind) {
  if (KEYWORDS.has(name) || name.startsWith('_') || STYLE[kind].re.test(name)) return;   // имя в порядке

  // Какое имя предложить вместо неправильного
  const newName = kind === 'variable' ? toSnake(name)
    : kind === 'constant' ? 'k' + pascal(name)
    : pascal(name);
  if (!newName || newName === name) return;   // исправить не получится — не предлагаем

  issues.push({
    line, start: col, end: col + name.length, rule: 'naming', newName,
    message: `Имя «${name}» должно быть в стиле ${STYLE[kind].title} (например, ${newName})`,
  });
}

/** Объявление типа: class Foo { / struct Foo : / enum class Foo; (только объявления, не использования). */
const TYPE_RE = /\b(?:class|struct|union|enum(?:\s+(?:class|struct))?)\s+([A-Za-z_]\w*)(?=\s*(?:[{:;]|$))/g;
/** Псевдоним типа: using Name = ...; */
const USING_RE = /\busing\s+(\w+)\s*=/;
/** Простой typedef: typedef int Name; */
const TYPEDEF_RE = /^\s*typedef\b[^;{}]*?\b(\w+)\s*;/;
/** Начало объявления функции: «[модификаторы] тип имя(». Группа 1 — тип, группа 2 — имя. */
const FUNC_RE = /^\s*(?:(?:static|inline|virtual|constexpr|explicit|extern|friend|const|unsigned|signed)\s+)*([A-Za-z_][\w:]*(?:<[^()]*>)?)[\s*&]+(?:\w+::)*(\w+)\s*\(/;
/** Параметр функции имеет вид «тип имя» (например, «const std::string& s»). */
const PARAM_RE = /^[\w:<>,\s*&]*[\s*&]\w+(\s*\[[^\]]*\])?$/;
/** Объявление переменной: «[const] тип [*&] имя» и далее один из знаков = ; [ { , ) : */
const VAR_RE = /^\s*(?:for\s*\(\s*)?((?:(?:static|constexpr|const|inline|extern|volatile|mutable|register|thread_local|unsigned|signed|long|short)\s+)*)([A-Za-z_][\w:]*(?:<[^;=()]*>)?)((?:\s*[*&]+\s*|\s+)(?:const\s+)?)(\w+)\s*(=|;|\[|\{|,|\)|:(?!:))/;

/**
 * Делит текст параметров функции по запятым верхнего уровня.
 * Запятые внутри <...> и (...) не считаются разделителями.
 *
 * Параметры:
 *     s (string): текст между скобками функции, например "int a, std::map<int, int> m"
 *
 * Возвращаемое значение:
 *     результат ({text: string, offset: number}[]): список параметров: text — текст параметра, offset — номер символа, с которого он начинается внутри s
 *
 * Пример вызова:
 *     splitParams('int a, int b');   // → [{text:'int a', offset:0}, {text:' int b', offset:6}]
 */
function splitParams(s: string): { text: string; offset: number }[] {
  const out: { text: string; offset: number }[] = [];
  let depth = 0;   // глубина вложенности скобок < и (
  let from = 0;    // где начался текущий параметр
  for (let i = 0; i <= s.length; i++) {
    const c = s[i];
    if (c === '<' || c === '(') depth++;
    else if (c === '>' || c === ')') depth--;
    else if (i === s.length || (c === ',' && depth === 0)) {
      out.push({ text: s.slice(from, i), offset: from });   // параметр закончился
      from = i + 1;
    }
  }
  return out;
}

/**
 * Проверяет имена в строках файла: типы, функции (и их параметры), переменные, константы.
 * Если случай нельзя определить надёжно — строка пропускается (ложные срабатывания недопустимы).
 *
 * Параметры:
 *     masked (string[]): «закрашенные» строки файла
 *     issues (Issue[]): общий список нарушений, куда добавляются найденные
 *
 * Возвращаемое значение:
 *     нет (void): ничего не возвращает, а дописывает результат в issues
 *
 * Пример вызова:
 *     // 'int userName = 5;'      → нарушение: userName → user_name
 *     // 'int calculateSum(int a)' → нарушение: calculateSum → CalculateSum
 *     // 'class user_data {'       → нарушение: user_data → UserData
 */
function checkNaming(masked: string[], issues: Issue[]) {
  masked.forEach((line, n) => {
    // ---- типы: class / struct / enum / using / typedef ----
    for (const m of line.matchAll(TYPE_RE)) {
      // Имя стоит в конце совпадения; вычитаем возможные пробелы после него
      const col = m.index! + m[0].length - m[1].length - (m[0].length - m[0].trimEnd().length);
      checkName(issues, n, col, m[1], 'type');
    }
    const u = USING_RE.exec(line);
    if (u) checkName(issues, n, line.indexOf(u[1], u.index + 5), u[1], 'type');
    const t = TYPEDEF_RE.exec(line);
    if (t) checkName(issues, n, line.lastIndexOf(t[1]), t[1], 'type');

    // ---- функции и их параметры ----
    const f = FUNC_RE.exec(line);
    if (f && !KEYWORDS.has(f[1]) && !KEYWORDS.has(f[2])) {
      const open = f[0].length - 1;               // позиция открывающей скобки '('
      const close = findClose(line, open);        // позиция закрывающей ')'
      if (close < 0) return;                      // параметры на нескольких строках — пропускаем

      const params = line.slice(open + 1, close);                   // текст между скобками
      const pieces = params.trim() === '' ? [] : splitParams(params);   // список параметров
      /**
       * Отбрасывает значение параметра по умолчанию: всё, что после «=», и пробелы по краям.
       *
       * Параметры:
       *     s (string): текст одного параметра, например «int a = 5»
       *
       * Возвращаемое значение:
       *     результат (string): параметр без значения по умолчанию, например «int a»
       *
       * Пример вызова:
       *     withoutDefault('int a = 5');   // → 'int a'
       */
      const withoutDefault = (s: string) => s.split('=')[0].trim();     // отбрасываем значение по умолчанию (= 5)

      // Это функция, если все параметры имеют вид «тип имя» (иначе это, например, Foo bar(1, 2);)
      const isFunction = params.trim() === 'void' || pieces.every(p => PARAM_RE.test(withoutDefault(p.text)));
      if (!isFunction) return;

      checkName(issues, n, line.lastIndexOf(f[2], open), f[2], 'function');

      for (const p of pieces) {
        const base = p.text.split('=')[0];                           // параметр без значения по умолчанию
        const pm = /(\w+)(\s*\[[^\]]*\])?\s*$/.exec(base);           // имя — последнее слово параметра
        if (pm && params.trim() !== 'void') {
          checkName(issues, n, open + 1 + p.offset + pm.index, pm[1], 'variable');
        }
      }
      return;   // строку с функцией дальше как переменную не разбираем
    }

    // ---- переменные и константы ----
    const v = VAR_RE.exec(line);
    if (!v) return;
    const [, mods, type, decl, name, term] = v;    // модификаторы, тип, звёздочки/&, имя, завершающий знак
    if (KEYWORDS.has(type) || KEYWORDS.has(name)) return;

    // Константа — это const/constexpr с инициализацией. Два случая:
    //   1) «const int kMax = 5;»        — const стоит в начале, звёздочек и & нет;
    //   2) «const char* const kName = ...» — сам указатель константный (const стоит ПОСЛЕ звёздочки).
    // А «const char* p» и «const std::string& s» (указатель/ссылка НА константу) константами не считаются.
    const isConstPointer = /\*\s*const\s+$/.test(decl);
    const isPlainConst = /\b(const|constexpr)\b/.test(mods) && !/[*&]/.test(decl);
    const isConstant = (term === '=' || term === '{') && (isConstPointer || isPlainConst);
    const col = line.lastIndexOf(name, v[0].length - term.length);   // где в строке начинается имя
    checkName(issues, n, col, name, isConstant ? 'constant' : 'variable');
  });
}

// ===================================================================
// 6. Публичные функции (их использует extension.ts)
// ===================================================================

/**
 * Главная функция проверки: находит все нарушения стиля в тексте программы.
 *
 * Параметры:
 *     text (string): полный текст файла C/C++
 *
 * Возвращаемое значение:
 *     результат (Issue[]): список нарушений, отсортированный по номеру строки
 *
 * Пример вызова:
 *     const issues = check('int main() {\n   int a=1;\n}');
 *     // issues[0].rule === 'indentation'  (3 пробела)
 *     // issues[1].rule === 'spacing'      (нет пробелов вокруг «=»)
 */
export function check(text: string): Issue[] {
  const lines = text.split(/\r?\n/);     // делим на строки (поддерживаем и \n, и \r\n)
  const masked = maskLines(lines);       // «закрашиваем» комментарии и строки
  const issues: Issue[] = [];
  checkIndent(lines, masked, issues);
  checkSpacing(masked, issues);
  checkBraces(lines, masked, issues);
  checkNaming(masked, issues);
  return issues.sort((a, b) => a.line - b.line || a.start - b.start);   // сортируем по строке, затем по позиции
}

/**
 * Применяет правки к тексту. Правки, которые пересекаются с уже применёнными, пропускаются
 * (чтобы две правки не испортили друг друга).
 *
 * Параметры:
 *     text (string): исходный текст файла
 *     edits (Edit[]): список правок (обычно собранный из issue.edits)
 *
 * Возвращаемое значение:
 *     результат (string): новый текст с применёнными правками (строки соединены через «\n»)
 *
 * Пример вызова:
 *     applyEdits('a=1;', [{line: 0, start: 1, end: 2, text: ' = '}]);   // → 'a = 1;'
 */
export function applyEdits(text: string, edits: Edit[]): string {
  const lines = text.split(/\r?\n/);
  // Применяем с конца файла к началу, чтобы правки не сдвигали позиции друг друга
  const sorted = [...edits].sort((a, b) => b.line - a.line || b.start - a.start);
  let lastLine = -1;    // строка последней применённой правки
  let lastStart = 0;    // где последняя применённая правка начиналась
  for (const e of sorted) {
    if (e.line === lastLine && e.end > lastStart) continue;   // правка пересекается с уже применённой — пропускаем
    lines[e.line] = lines[e.line].slice(0, e.start) + e.text + lines[e.line].slice(e.end);
    lastLine = e.line;
    lastStart = e.start;
  }
  return lines.join('\n');
}

/**
 * Считает оценку стиля в процентах по формуле
 * score = max(0, round(100 − нарушения / строки × 100)).
 *
 * Параметры:
 *     violations (number): количество нарушений
 *     lineCount (number): количество строк в файле (0 для пустого файла)
 *
 * Возвращаемое значение:
 *     результат (number): оценка от 0 до 100; для пустого файла и файла без нарушений — 100
 *
 * Пример вызова:
 *     score(0, 50);    // → 100
 *     score(5, 50);    // → 90
 *     score(80, 50);   // → 0  (не может быть меньше нуля)
 *     score(0, 0);     // → 100 (пустой файл)
 */
export function score(violations: number, lineCount: number): number {
  return lineCount === 0 ? 100 : Math.max(0, Math.round(100 - violations / lineCount * 100));
}