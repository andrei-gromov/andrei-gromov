/**
 * Skyline для GitHub README. Node.js 22+, без npm-зависимостей.
 * Даты и серии считаются по UTC. Демо включается только флагом --demo.
 * Геометрия, высоты и волна адаптированы из предоставленного ContributionSkyline.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY = 86_400_000;
const WIDTH = 1000;
const HEIGHT = 680;
const DURATION = 14;
export const COLORS = {
  background: '#0d1117', border: '#30363d', text: '#e6edf3', muted: '#9198a1',
  accent: '#ff934f', levels: ['#21262d', '#0e4429', '#006d32', '#26a641', '#39d353'],
};
const key = ms => new Date(ms).toISOString().slice(0, 10);
const dayMs = date => Date.parse(`${date}T00:00:00Z`);
const clamp = value => Math.max(0, Math.min(1, value));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
const xml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
})[char]);
const number = value => value.toLocaleString('en-US');
const pretty = (date, year = false) => date ? new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
  month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC',
}) : '—';
const range = (start, end) => start ? `${pretty(start)} – ${pretty(end)}` : 'No active days';

export function last365Days(now = Date.now()) {
  const end = Math.floor(now / DAY) * DAY;
  return Array.from({ length: 365 }, (_, index) => ({ date: key(end - (364 - index) * DAY), count: 0 }));
}

// GraphQL работает только с серверным токеном Actions. В SVG токен не попадает.
export async function graphql(query, variables, token, fetcher = fetch) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetcher('https://api.github.com/graphql', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
        'User-Agent': 'readme-contribution-skyline',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(60_000),
    });
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise(done => setTimeout(done, 1000 * (attempt + 1)));
      continue;
    }
    if (!response.ok) throw new Error(`GitHub API: HTTP ${response.status}. Проверь доступ токена и лимиты API.`);
    const result = await response.json();
    if (result.errors?.length) throw new Error(result.errors.map(error => error.message).join('; '));
    if (!result.data?.user) throw new Error('GitHub не вернул пользователя. Проверь GITHUB_USERNAME.');
    return result.data.user;
  }
}

export async function getActivity(username, token, mode, now = Date.now(), request = graphql) {
  const days = last365Days(now);
  if (!['commits', 'contributions'].includes(mode)) throw new Error('SKYLINE_MODE: commits или contributions.');

  if (mode === 'contributions') {
    const user = await request(`query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }
      }
    }`, { login: username, from: `${days[0].date}T00:00:00Z`, to: new Date(now).toISOString() }, token);
    const weeks = user.contributionsCollection?.contributionCalendar?.weeks;
    if (!Array.isArray(weeks)) throw new Error('В ответе GitHub отсутствует календарь активности.');
    const counts = new Map(weeks.flatMap(week => week.contributionDays).map(day => [day.date, day.contributionCount]));
    for (const day of days) {
      const count = counts.get(day.date);
      if (!Number.isInteger(count) || count < 0) throw new Error(`Неполные данные GitHub за ${day.date}.`);
      day.count = count;
    }
    return days;
  }

  // По одному totalCommitContributions на день: не смешиваем коммиты с PR/issues.
  // Пакеты из 28 дней обходят ограничения списка репозиториев и его пагинации.
  for (let offset = 0; offset < days.length; offset += 28) {
    const batch = days.slice(offset, offset + 28);
    const fields = batch.map((day, index) => {
      const to = new Date(Math.min(dayMs(day.date) + DAY - 1, now)).toISOString();
      return `d${index}: contributionsCollection(from: "${day.date}T00:00:00Z", to: "${to}") { totalCommitContributions }`;
    }).join('\n');
    const user = await request(`query($login: String!) { user(login: $login) { ${fields} } }`, { login: username }, token);
    batch.forEach((day, index) => {
      const count = user[`d${index}`]?.totalCommitContributions;
      if (!Number.isInteger(count) || count < 0) throw new Error(`Неполные данные GitHub за ${day.date}.`);
      day.count = count;
    });
  }
  return days;
}

export function statistics(days) {
  let total = 0;
  let current = 0;
  let run = 0;
  let runStart = null;
  let busiest = { count: 0, date: null };
  let longest = { days: 0, start: null, end: null };
  for (const day of days) {
    total += day.count;
    if (day.count > busiest.count) busiest = { count: day.count, date: day.date };
    if (day.count > 0) {
      if (!run) runStart = day.date;
      run++;
      if (run > longest.days) longest = { days: run, start: runStart, end: day.date };
    } else run = 0;
  }
  // Сегодня ещё можно закоммитить: отсутствие коммита сегодня не обрывает вчерашнюю серию.
  let index = days.length - 1;
  if (days[index]?.count === 0) index--;
  const end = days[index]?.date ?? null;
  while (index >= 0 && days[index].count > 0) { current++; index--; }
  return {
    total, busiest, longest,
    current: { days: current, start: current ? days[index + 1].date : null, end: current ? end : null },
  };
}

export function buildModel(days) {
  if (!days.length) throw new Error('Нет дней для визуализации.');
  days.forEach((day, index) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day.date) || !Number.isFinite(dayMs(day.date)) || key(dayMs(day.date)) !== day.date ||
      !Number.isInteger(day.count) || day.count < 0 || (index && dayMs(day.date) - dayMs(days[index - 1].date) !== DAY)) {
      throw new Error('Ожидались последовательные даты YYYY-MM-DD и неотрицательное целое count.');
    }
  });
  const offset = new Date(dayMs(days[0].date)).getUTCDay();
  const positive = days.map(day => day.count).filter(Boolean).sort((a, b) => a - b);
  const busy = positive[Math.floor((positive.length - 1) * 0.95)] ?? 0;
  const max = positive.at(-1) ?? 0;
  const cells = days.map((day, index) => ({
    ...day, week: Math.floor((index + offset) / 7), weekday: (index + offset) % 7,
    level: day.count ? 1 + Math.min(3, Math.floor(day.count / busy * 4)) : 0,
    height: day.count ? 0.4 + (day.count / max) ** 0.85 * 7.2 : 0.2,
  }));
  const weeks = cells.at(-1).week + 1;
  const months = [];
  let lastMonth = '';
  for (const cell of cells) {
    const month = cell.date.slice(0, 7);
    if (month !== lastMonth) {
      months.push({ week: cell.week, label: new Date(dayMs(cell.date)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) });
      lastMonth = month;
    }
  }
  if (months.length > 1 && months[1].week - months[0].week < 3) months.shift();
  return { cells, weeks, months, stats: statistics(days), first: days[0].date, last: days.at(-1).date };
}

// Одна сцена: та же сетка и те же столбики плавно меняют проекцию.
export function scene(model, progress) {
  const e = ease(progress);
  const yaw = Math.PI / 4 * e;
  const elevation = lerp(Math.PI / 2, 34 * Math.PI / 180, e);
  const cs = Math.cos(yaw), sn = Math.sin(yaw), se = Math.sin(elevation), ce = Math.cos(elevation);
  const project = (x, y, z = 0) => [x * cs - y * sn, (x * sn + y * cs) * se - z * ce];
  const width = lerp(0.78, 0.9, e), inset = (1 - width) / 2;
  const boxes = model.cells.map(cell => {
    const x = cell.week + inset, y = cell.weekday + inset;
    const delay = cell.week / Math.max(1, model.weeks - 1) * 0.36 + cell.weekday / 6 * 0.06;
    const height = cell.height * (1 - (1 - clamp((progress - delay) / 0.58)) ** 3);
    const a = project(x, y, height), b = project(x + width, y, height);
    const c = project(x + width, y + width, height), d = project(x, y + width, height);
    const baseB = project(x + width, y), baseC = project(x + width, y + width), baseD = project(x, y + width);
    return [[baseD, baseC, c, d], [baseB, baseC, c, b], [a, b, c, d]];
  });
  const labels = model.months.map(month => project(month.week + 0.5, lerp(-0.8, 7.8, e)));
  const vertices = boxes.flat(2).concat(labels, [project(0, 8.7), project(model.weeks, 8.7)]);
  const xs = vertices.map(point => point[0]), ys = vertices.map(point => point[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const bounds = { x: 48, y: lerp(228, 100, e), width: 904, height: lerp(162, 480, e) };
  const scale = Math.min(bounds.width / (maxX - minX), bounds.height / (maxY - minY));
  const ox = bounds.x + (bounds.width - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = bounds.y + (bounds.height - (maxY - minY) * scale) / 2 - minY * scale;
  const screen = point => [ox + point[0] * scale, oy + point[1] * scale];
  return { boxes: boxes.map(faces => faces.map(face => face.map(screen))), labels: labels.map(screen) };
}

const points = face => face.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
const shade = (color, factor) => '#' + color.slice(1).match(/../g).map(hex => Math.round(parseInt(hex, 16) * factor).toString(16).padStart(2, '0')).join('');
const text = (x, y, value, size = 14, fill = COLORS.text, extra = '') => `<text x="${x}" y="${y}" font-size="${size}" fill="${fill}" ${extra}>${xml(value)}</text>`;

function stat(x, y, label, value, unit, sub, align = 'start') {
  return `<g text-anchor="${align}">
    ${text(x, y, label, 13, COLORS.muted)}
    <text x="${x}" y="${y + 46}" fill="${COLORS.accent}" font-size="44" font-weight="600">${xml(number(value))}<tspan fill="${COLORS.text}" font-size="15" font-weight="400"> ${xml(unit)}</tspan></text>
    ${text(x, y + 69, sub, 12, COLORS.muted)}
  </g>`;
}

export function renderSVG(days, { username, mode = 'contributions', animated = true, demo = false } = {}) {
  const model = buildModel(days);
  const { stats } = model;
  const units = value => mode === 'commits' ? (value === 1 ? 'commit' : 'commits') : (value === 1 ? 'contribution' : 'contributions');
  // Пауза в 2D → подъём → пауза в 3D → возвращение. 20 промежуточных проекций.
  const phases = [{ time: 0, t: 0 }, { time: 0.12, t: 0 }];
  for (let index = 1; index <= 20; index++) phases.push({ time: 0.12 + index / 20 * 0.17, t: index / 20 });
  phases.push({ time: 0.79, t: 1 });
  for (let index = 1; index <= 20; index++) phases.push({ time: 0.79 + index / 20 * 0.17, t: 1 - index / 20 });
  phases.push({ time: 1, t: 0 });
  const frames = animated ? phases.map(phase => scene(model, phase.t)) : [];
  const finalScene = scene(model, 1);
  const keyTimes = phases.map(phase => phase.time.toFixed(4)).join(';');
  const animation = (attribute, values) => `<animate attributeName="${attribute}" dur="${DURATION}s" repeatCount="indefinite" calcMode="linear" keyTimes="${keyTimes}" values="${values.join(';')}"/>`;
  // Такой порядок перекрытия подходит для всей дуги камеры от 0° до 45°.
  const ordered = model.cells.map((cell, index) => ({ cell, index })).sort((a, b) => a.cell.week + a.cell.weekday - b.cell.week - b.cell.weekday);
  const geometry = moving => ordered.map(({ cell, index }) => {
    const color = COLORS.levels[cell.level];
    return `<g>${finalScene.boxes[index].map((face, faceIndex) => `<polygon points="${points(face)}" fill="${shade(color, [0.84, 0.68, 1][faceIndex])}">${moving ? animation('points', frames.map(frame => points(frame.boxes[index][faceIndex]))) : ''}</polygon>`).join('')}</g>`;
  }).join('\n') + model.months.map((month, index) => {
    const [x, y] = finalScene.labels[index];
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="11" fill="${COLORS.muted}">${month.label}${moving ? animation('x', frames.map(frame => frame.labels[index][0].toFixed(1))) + animation('y', frames.map(frame => frame.labels[index][1].toFixed(1))) + animation('opacity', phases.map(phase => (clamp(1 - phase.t / 0.3) + clamp((phase.t - 0.7) / 0.3)).toFixed(3))) : ''}</text>`;
  }).join('');
  const badge = demo ? 'DEMO · SAMPLE DATA' : 'LAST 365 DAYS';
  const description = `${demo ? 'Sample data, not a real GitHub profile. ' : ''}${username}: ${stats.total} ${units(stats.total)}. Longest streak ${stats.longest.days} days. Current streak ${stats.current.days} days. ${model.first} to ${model.last}, UTC.`;
  const cornerStats = [
    stat(949, 133, '1 year total', stats.total, units(stats.total), `${pretty(model.first, true)} – ${pretty(model.last, true)}`, 'end'),
    stat(949, 239, 'Busiest day', stats.busiest.count, units(stats.busiest.count), pretty(stats.busiest.date), 'end'),
    stat(48, 420, 'Longest streak', stats.longest.days, stats.longest.days === 1 ? 'day' : 'days', range(stats.longest.start, stats.longest.end)),
    stat(48, 525, 'Current streak', stats.current.days, stats.current.days === 1 ? 'day' : 'days', range(stats.current.start, stats.current.end)),
  ].join('');
  const rowStats = [
    ['1 year total', stats.total, units(stats.total), 'Last 365 days'],
    ['Busiest day', stats.busiest.count, units(stats.busiest.count), pretty(stats.busiest.date)],
    ['Longest streak', stats.longest.days, stats.longest.days === 1 ? 'day' : 'days', range(stats.longest.start, stats.longest.end)],
    ['Current streak', stats.current.days, stats.current.days === 1 ? 'day' : 'days', range(stats.current.start, stats.current.end)],
  ].map(([label, value, unit, sub], index) => {
    const x = 48 + index * 229;
    return text(x, 476, label, 13, COLORS.muted) + text(x, 520, number(value), 36, COLORS.accent, 'font-weight="600"') +
      text(x, 544, unit, 14) + text(x, 568, sub, 12, COLORS.muted);
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-labelledby="title description">
  <title id="title">${xml(demo ? 'Skyline design preview — sample data' : `GitHub skyline — ${username}`)}</title>
  <desc id="description">${xml(description)}</desc>
  <style>
    text { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif; font-variant-numeric: tabular-nums; }
    .still { display: ${animated ? 'none' : 'inline'}; }
    @media (prefers-reduced-motion: reduce) { .motion { display: none; } .still { display: inline; } }
  </style>
  <rect x="0.5" y="0.5" width="999" height="679" rx="16" fill="${COLORS.background}" stroke="${COLORS.border}"/>
  ${text(30, 40, 'Contribution skyline', 18, COLORS.text, 'font-weight="600"')}
  ${text(970, 39, badge, 11, COLORS.muted, 'text-anchor="end" letter-spacing="1.4"')}
  <rect x="24.5" y="72.5" width="951" height="581" rx="10" fill="none" stroke="${COLORS.border}"/>
  ${text(46, 103, demo ? 'PREVIEW · NOT YOUR ACTIVITY' : `@${username}`, 12, COLORS.muted)}
  <g class="still">${geometry(false)}</g>
  ${animated ? `<g class="motion">${geometry(true)}</g>` : ''}
  <g class="still">${cornerStats}</g>
  ${animated ? `<g class="motion" opacity="1">${cornerStats}${animation('opacity', phases.map(phase => clamp((phase.t - 0.65) / 0.35).toFixed(3)))}</g>
  <g class="motion" opacity="0">${rowStats}${animation('opacity', phases.map(phase => clamp(1 - phase.t / 0.3).toFixed(3)))}</g>` : ''}
  <path d="M44 612H956" stroke="${COLORS.border}"/>
  ${text(46, 638, demo ? 'Sample data · Your activity loads on GitHub Actions' : `Updated ${pretty(model.last, true)} · UTC`, 11, COLORS.muted)}
  ${text(784, 638, 'Less', 11, COLORS.muted)}
  ${COLORS.levels.map((color, index) => `<rect x="${818 + index * 18}" y="627" width="12" height="12" rx="2" fill="${color}"/>`).join('')}
  ${text(921, 638, 'More', 11, COLORS.muted)}
</svg>\n`;
}

export function demoDays(now = Date.now()) {
  let seed = 17;
  const random = () => { seed = Math.imul(1664525, seed) + 1013904223 | 0; return (seed >>> 0) / 4294967296; };
  return last365Days(now).map((day, index) => {
    const weekend = [0, 6].includes(new Date(dayMs(day.date)).getUTCDay());
    const busy = 0.5 + 0.5 * Math.sin(index / 23);
    const active = random() < (weekend ? 0.42 : 0.85);
    return { ...day, count: active ? 1 + Math.floor(random() * (4 + busy * 22)) : 0 };
  });
}

export async function main() {
  const demo = process.argv.includes('--demo');
  const username = process.env.GITHUB_USERNAME || process.env.GITHUB_REPOSITORY_OWNER || (demo ? 'preview' : '');
  const mode = process.env.SKYLINE_MODE || 'contributions';
  const token = process.env.GITHUB_TOKEN;
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(username)) throw new Error('Укажи корректный GITHUB_USERNAME.');
  if (!['commits', 'contributions'].includes(mode)) throw new Error('SKYLINE_MODE: commits или contributions.');
  if (!demo && !token) throw new Error('Не задан GITHUB_TOKEN. Запусти через GitHub Actions; --demo предназначен только для просмотра.');
  const days = demo ? demoDays() : await getActivity(username, token, mode);
  const folder = resolve(process.env.OUTPUT_DIR || (demo ? 'preview' : 'assets'));
  // Обе картинки сначала строятся в памяти: при ошибке API старые файлы не меняются.
  const animated = renderSVG(days, { username, mode, demo });
  const still = renderSVG(days, { username, mode, demo, animated: false });
  await mkdir(folder, { recursive: true });
  const prefix = demo ? 'skyline-demo' : 'commit-skyline';
  await writeFile(join(folder, `${prefix}.svg`), animated);
  await writeFile(join(folder, `${prefix}-static.svg`), still);
  console.log(`Готово: ${prefix}.svg и ${prefix}-static.svg (${demo ? 'демо' : mode}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(`Skyline: ${error.message}`); process.exitCode = 1; });
}
